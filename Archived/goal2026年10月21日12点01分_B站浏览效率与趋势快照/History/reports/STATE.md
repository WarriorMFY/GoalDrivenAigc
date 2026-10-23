# 运行状态与交接说明

> 最后更新：2026-10-22 09:00（窗口进行中，已运行约 21 小时；官方快照 2 份有效 + 1 份永久丢失）
> 本文件是给"未来的人"看的：不需要读对话历史，只读这里 + `Tool/Tool.md`。

## ⚠️ 一、当前目标已不可达（重要）

**`10-21 20:00` 官方快照永久丢失**。原因是主机休眠（18:05→01:53 空白 7h48m），迟到 353 分钟超过 2 小时闸门，按规则拒绝补采（不能用上午数据冒充昨晚 20:00）。

`M1` 要求 `S=6` 且时点偏差 ≤10 分钟。剩余时点最多只能到 **4/6**（13:00、20:00、次日 08:00 三份全按时）。**故窗口结束时 `audit.mjs` 必然返回 FAILED**，除非用户修改 `M1` 判据。

三条候选路径（用户尚未选择）：A 放宽 M1 为「有效快照 ≥4 + 缺失必须有原因留痕」；B 接受 FAILED 并如实记录；C 延长窗口补齐（违反现有条文，不推荐）。

## 二、故障处理记录（2026-10-22 上午）

| 问题 | 根因 | 处理 |
|---|---|---|
| 7h48m + 6h40m 采样空白 | 主机休眠，定时器停摆，无报错 | 新增 `gap` 事件检测（light>25min / full>90min） |
| `ranking/v2` 返回 `-352` 而其他接口正常 | 分端点、分钟级冷却（4 分钟后自愈） | `-352/-412` 立即放弃，不再退避重试（退避会延长封锁） |
| 每 50 秒反复重打接口 | 迟到补采失败记 `missed` 后未被跳过 | 索引中已有记录即不再重采 |
| `config.json` 解析失败 | PowerShell 5.1 `Set-Content -Encoding UTF8` 写入 BOM | 改用 node 写文件；JSON 一律用 node 修改 |

## 三、当前采集器

`node Tool/bili/collect.mjs --serve`（受管 job）。light 8 分钟、full 30 分钟、官方时段 08:00/13:00/20:00。
若 `History/collector.log` 最后一行超过 30 分钟未更新 → 重启：`node Tool\bili\collect.mjs --serve`（必须用受管后台 job，`Start-Process` 会被回收）。

## 〇、最重要的两条结论（若只看一处）

1. **排行榜池 cohort 增速在 17:40 出现真实抬升**：0.361% → 0.401 → 0.404 → 0.419 → 0.450 → **0.573%**/30min（+59%）。前四点构成基线 0.40%，后两点偏离到 1.13× 与 1.43×。这是整个窗口唯一被确认的结构性趋势。
2. **聚合量不可用于趋势判断**：热门池 16:20→17:24 的截面总量跌 20%，同期排行榜涨 0.25%。原因是高播放视频被替换出池，不是热度下降。

## 〇之二、尚未验证的改动（需要下一个人确认）

18:00 前刚给 `detectEvents` 加了两条**滑动基线**规则（`ramp` ≥1.3×、`slow` ≤0.7×，基线 = 同类型最近 6 条 `cohortPct` 中位数，需 ≥3 个历史点）。按回测，17:40 的 +0.57% 应触发 `ramp`（1.43×）。**但下一次 full（18:10）在最后轮次之后才发生，我没能看到它真正触发。**

如果要确认，请在 18:10 之后看：

```powershell
node -e "const fs=require('fs');console.log(fs.readFileSync('History/events.ndjson','utf8').split('\n').filter(Boolean).slice(-3).join('\n'))"
```

若出现 `ramp` 事件且数值约 1.4×，说明规则生效；若没有，检查 `recentCohortPct` 是否取到足够历史点。

## 一、现在有什么在跑

- **采集器**：`node Tool/bili/collect.mjs --serve`，当前是 DSH 受管后台 job。
- 节奏：light 每 8 分钟（1 请求 popular），full 每 30 分钟（3 请求 + 写 `latest.md` + 事件判定），官方时段 08:00/13:00/20:00 额外产出正式快照。
- **它不可自愈**：DSH 会话或主机重启会终止它。重启方法见下。

## 二、如果采集器死了

```powershell
cd GoalDrivenAigc
node Tool\bili\collect.mjs --serve      # 必须用受管后台 job，不能用 Start-Process
```

**重要**：`start-mode` 只能用受管 job。实测 `Start-Process` 启动的分离进程会随父 shell 被回收，而且沙箱禁止用 WMI（`Get-CimInstance`）枚举进程，所以事后无法清理僵尸进程。重启前先确认没有旧实例在跑（看 `History/collector.log` 是否有重复的"启动"行）。

断点续采是安全的：已完成时段从 `History/snap_index.json` 读，不会重复采；超出 10 分钟容差的时段会记 `missed`，按 Goal.md **不补采**。

## 三、窗口结束时该做什么

```powershell
node Tool\bili\finalize.mjs
```

一条命令刷新 `trend_log.md`、`trend_report.md`，跑 `audit.mjs` 并把判定写进 `verdict.json`。

预期此时：6 个官方快照齐全、`M4.overlap_median` 有 5 组配对、`M3.E6.exp` 已完成。**唯一预计仍会失败的是 `M5.goal_hardlimit_match`**——`Goal.md` 第 57 行写「总调用 > 96 calls 即 FAILED」，而实际配置与 Goal.md 的 M3.E4 都是 200/240。这需要用户改 `Goal.md`，我不能改。

## 四、已完成的关键产物

| 文件 | 内容 |
|---|---|
| `History/browse_practice.md` | 9 条已成立的结论（压缩、cohort、风控、采样时标、池流动性、事件驱动等） |
| `History/trend_log.md` | 小时级趋势序列（按池分行，脚本可复算） |
| `History/trend_report.md` | 官方快照总表（当前 1 份，结束时重生成） |
| `History/exp_compress.json` | E6 对照实验：90.1x token 压缩，关键事实 10/10 |
| `History/probe_risk.json` | 风控探针：同端点 1s×10 全部 200；跨端点遍历触发 -352 |
| `History/stream/samples.ndjson` | 流式样本（含 `views` 数组，可复算 cohort） |
| `History/events.ndjson` | L1 触发事件 |
| `History/l2_rounds.ndjson` | 每轮 LLM 覆盖了哪些样本（M6 证据） |
| `Tool/Tool.md` | 工具手册与设计决策（含代价说明） |

## 五、已知缺陷（报告需注明，未修）

1. 每类样本的第一条没有前一条可比，`added` 记为全量（50 条）→ `trend_log.md` 中 13:00 小时"换血累计 158"是假数字。
2. `latest.md` 只由 full 采样重写；light 事件触发时才会即时刷新，否则内容可能滞后最多 30 分钟。
3. 2026-10-21 13:39 前后曾因误用 `Start-Process` 导致约 10 分钟无样本（已恢复，未超过 M6.1 的 5% 缺失率）。

## 六、不要做的事

- 不要修改 `Goal/Goal.md`（仅用户可写）。
- 不要修改 `History/` 下的数据文件来"修好"数字——判定依赖 sha256 一致性，改了就会 FAIL。
- 不要为了凑快照数在窗口外补采。
