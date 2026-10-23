# History\ —— 唯一入口

> 目标：2026-10-21 12:01 → 10-23 12:01（48 小时）｜B 站公开数据浏览效率与趋势快照
> **判定**：`checks/verdict.json` → `verdict = PASS`，失败项 0（46 项检查）
> 本目录**根级只有这一个文件**，其余全部分类存放。要看什么，按下面的"阅读顺序"跳。

## 一句话结论

脚本压缩把 250 KB 原始数据压到 2.7 KB（**90.1x**，关键事实 10/10 保留）；判断趋势必须用 **cohort 增量**而不是截面聚合量（同一数据差 9 倍，换血时方向会反）；增速**基线随时段变化 3.6 倍**，只能对残差报警。

## 按角色选阅读路径

**① 我只想知道结论（5 分钟）**
→ `reports/收获总结.md`

**② 我要完整方法论（30 分钟）**
→ `reports/browse_practice.md`（14 条结论 + 6 条已知缺陷）

**③ 我要看趋势数据本身**
→ `reports/trend_report.md`（5 个官方时段的涨幅榜/新进/掉榜）
→ `reports/trend_log.md`（307 条流样本的小时级序列）

**④ 我要复核判定是否可信**
→ `checks/verdict.json`（逐项）
→ `index/snap_index.json`（每份快照的 sha256、体积、重合度）

**⑤ 我要接手继续做（新目标）**
→ `reports/STATE.md`（运行状态、故障记录、重启方法）
→ `../Tool/Tool.md`（工具索引）

## 目录结构

```
History/
├── history.md              ← 唯一入口（本文件）
├── index/                  索引
│   └── snap_index.json       官方快照索引：时段/实际时间/体积/压缩比/sha256/重合度
├── snapshots/              官方快照三层产物（21 个文件 = 5 份 × 3 层 + 2 份失败尝试）
│   ├── <stamp>.digest.md     趋势层 2.7–3.7 KB  ← LLM 只读这个
│   ├── <stamp>.csv           明细 110 条（脚本下钻用）
│   └── <stamp>_raw.json      原始响应 ~285 KB（不读，仅 sha256 校验与复算）
├── stream/                 流式采样
│   ├── samples.ndjson        每 8/30 分钟一条，含 top50 与 views 数组（供算 cohort）
│   └── latest.md             当前状态摘要 ≤1.2 KB
├── events/                 阈值触发
│   └── events.ndjson         113 条（churn / ramp / slow / hot / surge / risk / gap）
├── runs/                   运行留痕
│   ├── collector.log         采集器日志
│   ├── l2_rounds.ndjson      179 轮，每轮覆盖了哪些样本（"不跳读"的证据）
│   └── DONE.flag             自动收尾记录（08:10:18 自主触发）
├── reports/                人类阅读层
│   ├── 收获总结.md            5 条最值钱的结论 + 3 条最贵的教训
│   ├── browse_practice.md    完整方法论与缺陷清单
│   ├── trend_report.md       官方快照趋势总表
│   ├── trend_log.md          小时级序列
│   └── STATE.md              运行状态与交接
└── checks/                 校验与对账
    ├── verdict.json          判定明细（46 项）
    ├── budget_snapshot.json  额度对账（585/700 calls，¥6.67）
    ├── exp_compress.json     E6 对照实验（90.1x，保留 10/10）
    └── probe_risk.json       风控探针结果
```

## 关键数字

| 项 | 值 |
|---|---|
| 官方快照 | 5 份落盘（有效 4 / 迟到补采 1 / 丢失留痕 1） |
| 流样本 | 307 条（light 242 / full 65），覆盖 47/48 小时 |
| 事件 | 113 条 |
| 压缩 | 90.1x token，关键事实 10/10 |
| 成本 | 585 calls ≈ ¥6.67（预算 ¥10） |
| 判定 | PASS，失败项 0 |

## 两处必须知道的"不可信"数据

1. `runs/../`（即 `reports/trend_log.md`）中 **13:00 小时"换血累计 158"是假数字**——每类样本的第一条没有前值，`added` 被记为全量。
2. `events/events.ndjson` 中有 **1 条空样本假事件**（10-23 01:27「换血 0+50」），**未删除**（判定数据不应事后修改），引用事件统计时需减 1。

完整缺陷清单见 `reports/browse_practice.md` §已知缺陷。
