# collect.mjs —— 采集器实践

> 一句话：抓 3 个接口 → 归一化 → 三层落盘 → 更新索引。**判定数据唯一来源。**
> 索引见 [../Tool.md](../Tool.md)；分层与可比性见 [data-model.md](data-model.md)。

## 命令

```powershell
node Tool\bili\collect.mjs --serve              # 常驻：按 config 自动采（必须用受管后台 job）
node Tool\bili\collect.mjs --light              # 立刻做一次轻采样（1 请求）
node Tool\bili\collect.mjs --full               # 立刻做一次全采样（3 请求 + latest.md + 事件）
node Tool\bili\collect.mjs --list               # 计划时段 vs 完成情况
node Tool\bili\collect.mjs --once --slot <iso>  # 手动补采某时段（正式快照）
node Tool\bili\collect.mjs --once --label test --out History\_test --noindex   # 自检，不写索引
```

## 三档采样

| 档 | 频率 | 请求 | 产物 | LLM 成本 |
|---|---|---|---|---|
| light | 每 8 分钟 | 1（`popular`） | `stream/samples.ndjson` 一条 | 0 |
| full | 每 30 分钟 | 3 | 流样本 + `latest.md` + 事件判定 | 0 |
| 官方快照 | 命中 `Goal.md` 时段 | 3 | raw/csv/digest/索引，计入 M1 | 0 |

**light 为什么是 8 分钟**：自治轮次单次命令硬上限 10 分钟，采样周期必须短于它，否则等待窗内可能无样本（空放一轮）。这是环境约束倒推出来的值，不是拍脑袋。

## 三个接口

```
ranking/v2?rid=0&type=all          全站排行 100 条 → 取前 50（含 tname 二级分区）
popular?ps=50&pn=1                 热门池 50 条
search/square?limit=10             搜索热词 10 条（trending.list）
```

**只打 3 个请求的原因**：原始设计是"10 个分区各打一次排行"，实测第 10 个起 `-352`。改为任务条目自带的 `tname` 聚合分区热度，零额外请求。
**代价**：分区粒度是二级分区（数码/手机游戏/鬼畜调教），拿不到一级大区（科技/游戏）。要一级大区需额外请求，代价高，故不做。

## 请求头：ranking 必须单独一套

```js
HDRS      // 桌面 UA + Referer: bilibili.com   → 用于 popular / hotsearch
HDRS_RANK // 桌面 UA，无 Referer               → 专用于 ranking
```

原因（2026-10-23 07:58 实测，同 URL 同 IP 间隔 1 秒）：

| 请求头 | 结果 |
|---|---|
| 桌面 UA + `Referer: bilibili.com` | **`-352`** |
| 桌面 UA，无 Referer | `code=0`，100 条 |
| 移动 UA | `code=0`，100 条 |
| TV UA | `-352` |

**这是请求指纹规则，与频率、配额无关**。3.2 小时静默期毫无作用，换头立刻恢复。历史教训：曾误判为"资源遍历 → 分钟级冷却"，为此白白砍掉 3 小时数据。

`lib.mjs` 的 `fetchJson(url, { headers })` 支持覆盖请求头，就是为这个场景加的。

## 错误分级（不要统一重试）

| 情况 | 处理 |
|---|---|
| 网络异常 / 超时 | `fetchJson` 内重试 3 次，退避 6s、20s |
| `-352` / `-412` | **`fetchJson` 立即放弃**（冷却期内继续重打只会延长封锁） |
| full 采样中 ranking 失败 | 单独等 **120s 重试一次**，仍失败则该样本记 `cov=2/3` |
| 官方快照失败 | 按 `snapshotRetryWaitsMs` 重试 **+120s / +360s**（总耗时 <10min，仍在 M1 容差内） |
| 迟到 ≤2 小时 | 仍采，标 `late`，不计入有效快照 |
| 迟到 >2 小时 | **拒绝补采**，记 `missed`（`lateCollectMaxMin=120`）——把上午数据贴昨晚标签是造假 |

## 跨层级冷却

`minTierGapMs = 60000`：light 与 full 同时到期时，原逻辑会在 20 秒内先后打 `popular` 和 `ranking`，构成"短时间跨端点遍历"。现在任一层级调用后 60 秒内不再发起另一层级。官方时段不受此限。

## ranking 静默期

`config.rankingPauseUntil`（ISO 时间）：在此之前跳过所有 full 采样，完全不碰 `ranking`，用于官方时段前让它彻底冷掉。代价是**该时段没有 ranking 池的流样本**。

## digest 的生成与降档

`maxDigestBytes = 4096`。超限自动降档：Top20→16→12→10→8，上升榜与 Δ 同步收缩；降档记录在索引的 `trimmed` 字段，不隐瞒。四板块固定：全站Top / 分区热度 / 搜索热词 / 上升Top（+ 从第二份起带 Δ）。

## 去重

同一 `bvid` 会同时出现在排行榜与热门池。`dedupeByBvid` 保留排行优先者，否则"分区热度"的条目数被重复计数污染（首次自检时抓到的 bug）。

## 空样本守卫（三次同类 bug 换来的）

**空样本不得参与任何比较，也不得覆盖摘要**：

- `lastSampleOfKind(kind, { nonEmpty: true })` —— 跳过失败的 prev
- 本次采集为空（`!viewSum`）时 `prev` 直接置 null
- `detectEvents` 遇空样本只记 `risk`，不做相对判断
- `writeLatest` 遇空样本跳过写入

否则会产生"换血 0+50""重合 0%"这类假事件（历史上出现过两次）。

## 安全阀

`maybeFinalize()` 每轮检查，满足任一条件即自动跑 `finalize.mjs` 并写 `History/DONE.flag`：
1. 窗口结束；2. 全部官方时点已结算且已过最后一个时点的容差。

设计意图：**收尾正确性与"LLM 是否在线"解耦**。实测 2026-10-23 08:10:18 自主触发成功。

## 参数（config.json）

| 键 | 当前值 | 含义 |
|---|---|---|
| `window` | 见 Goal.md | 必须与 Goal.md 一致，audit 会逐字比对 |
| `slots` | `[8,13,20]` | 每日官方时段 |
| `maxDigestBytes` | 4096 | digets 硬上限 |
| `minItems` | 100 | M2 要求 |
| `topN` | 50 | 全站排行取前 N |
| `toleranceMin` | 10 | 时点偏差容差（M1） |
| `lateCollectMaxMin` | 120 | 迟到补采上限 |
| `throttleMs` | 2500 | 接口间隔 |
| `retries` | 3 | 单请求重试 |
| `minTierGapMs` | 60000 | 跨层级冷却 |
| `snapshotRetryWaitsMs` | `[120000, 360000]` | 官方快照重试时序 |
| `rankingPauseUntil` | 见 config | ranking 静默期终点 |
| `sampling.lightEveryMin` / `fullEveryMin` | 8 / 30 | 双层采样周期 |
| `budget.callsLimit` / `callsHardLimit` | 700 / 850 | 额度 |

## 底层（lib.mjs）

取数与哈希、时区与时间格式、CSV 读写（含引号转义）、token 估算、计划时段推导（`expectedSlots`）、从 `Goal.md` 解析时间窗（`goalWindow`）、`fnum`（万/亿缩写）、`sha256`。

**B 站只能走 Node fetch**：本机 PowerShell `Invoke-WebRequest` 与 `curl.exe` 的 TLS 全部失败（`schannel: AcquireCredentialsHandle failed`），Node v24 `fetch` 正常。
