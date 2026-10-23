# Tool\ —— 工具索引

> 目标见 `..\Goal\Goal.md`（仅用户可写）。
> **判定只有一条出口**：`node Tool\bili\audit.mjs` 的 `verdict`（PASS / FAILED / PENDING）。对话里的"完成了"不算数。
> 本文件只做索引；**每个工具的实践细节在同名文档里**，读哪个取决于你在做什么。

## 按任务找工具

| 我要做的事 | 用哪个 | 详情 |
|---|---|---|
| 持续采集 / 补采某个时段 | `bili\collect.mjs` | [collect.md](bili/collect.md) |
| 判断目标是否达成 | `bili\audit.mjs` | [audit.md](bili/audit.md) |
| 生成趋势总表 / 快照对比 / 压缩对照实验 | `bili\delta.mjs`、`bili\trend.mjs` | [analysis.md](bili/analysis.md) |
| 查额度 / 控制轮次节拍 / 一键收尾 / 测风控 | `bili\budget.mjs`、`pace.mjs`、`wait.mjs`、`finalize.mjs`、`probe_risk.mjs` | [ops.md](bili/ops.md) |
| 搞清楚数据怎么分层、哪些能比哪些不能比 | — | [data-model.md](bili/data-model.md) |
| 取数底层（fetch/哈希/CSV/时间） | `bili\lib.mjs` | 见 collect.md §底层 |
| 参数与接口地址 | `bili\config.json` | 见 collect.md §参数 |

## 最常用的三条

```powershell
node Tool\bili\collect.mjs --serve     # 常驻采集（必须用受管后台 job）
node Tool\bili\audit.mjs               # 判定，退出码 0=PASS 1=FAILED 2=PENDING
node Tool\bili\finalize.mjs            # 一键收尾：刷新全部产物 + 落 verdict.json
```

## 数据在哪（一层即可）

```
History\snap_index.json          官方快照索引（时段/体积/sha256/重合度）
History\<stamp>.digest.md        趋势层 ≤4KB ← LLM 只读这个
History\<stamp>.csv              明细 110 条
History\<stamp>_raw.json         原始响应 ~285KB（不读，仅校验）
History\stream\samples.ndjson    流式样本（每 8/30 分钟一条）
History\events.ndjson            阈值触发事件
History\latest.md                当前状态摘要 ≤1.2KB
```

分层规则与"哪些数字不能互相比较"见 [data-model.md](bili/data-model.md)。

## 红线

1. 不改 `Goal\Goal.md`（仅用户可写）；不改 `History\` 下已有数据（判定依赖 sha256）。
2. 判定数据必须由 `Tool\` 脚本产出；一次性命令只允许只读探查。
3. 窗口外不补采；迟到 >2 小时的时段拒绝补采（避免把今天的数据贴上昨天的标签）。
4. 不上代理池、不轮换指纹绕过封锁；被拒就退避降频。
