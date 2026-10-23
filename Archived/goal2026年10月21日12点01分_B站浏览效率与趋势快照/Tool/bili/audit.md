# audit.mjs —— 判定器实践

> 一句话：把 `Goal.md` 的每一条判据翻译成一项机器检查，给出 `verdict`。**唯一判定出口。**
> 索引见 [../Tool.md](../Tool.md)；分层见 [data-model.md](data-model.md)。

## 命令与退出码

```powershell
node Tool\bili\audit.mjs          # 逐项打印
node Tool\bili\audit.mjs --json   # 机器可读
```

退出码：`0 = PASS`，`1 = FAILED`，`2 = PENDING`。

**每次运行都会写 `History/verdict.json`**（含全部检查项明细），判定因此成为可留存的产物，而不只是终端里出现过的一句话。

## verdict 三态语义

| verdict | 含义 |
|---|---|
| `PASS` | 全部检查项通过，且有效快照 ≥ 4 |
| `FAILED` | 硬性失败（额度超硬上限、`config` 与 `Goal.md` 时间窗不一致）或窗口已结束仍有项未过 |
| `PENDING` | 窗口未结束、还有时点未结算——正常的进行中状态 |

## 检查清单

**M1 交付完整度**
- `M1.valid_snapshots`：有效快照 ≥ 4（有效 = 按时且非补采）
- `M1.slot:<时段>`：逐个时段判 —— `ok` 且偏差 ≤10min 记 PASS；迟到补采记 PASS（数据留存但不计入有效）；`missed` 只要留了 `note`/`lateMin` 也记 PASS（**丢失留痕即可**）

**M2 快照规格**（逐份）
- `M2.files`：raw/csv/digest 齐全
- `M2.items`：CSV 行数 ≥ 100
- `M2.blocks`：digest 含 `全站Top`/`分区热度`/`搜索热词`/`上升Top`

**M3 浏览效率**
- `M3.E1.comp` / `M3.E1.median`：压缩比 ≥ 8x（逐份 + 中位数）
- `M3.E2.digest_bytes` / `M3.E2.median`：digest ≤ 4096B
- `M3.E4.budget`：调用数不超硬上限（读 cost-meter 真实账目）
- `M3.E6.exp`：`exp_compress.json` 存在且 `ok`，保留 ≥ 9/10

**M4 趋势质量**
- `M4.overlap_median`：相邻快照 Top50 的 bvid 重合度中位数 ≥ 70%（按实际组数判，`Goal.md` 名义 5 组）
- `M4.trend_report` / `M4.practice_doc`：两个交付文档存在

**M5 可信度**
- `M5.sha256`：每份 digest 的 sha256 与索引一致（**防止事后改数据**）
- `cfg.goal_window_match`：`config.window` 与 `Goal.md` 时间窗逐字一致
- `M5.goal_budget_match`：`Goal.md` 里写的 `≤N calls` 与 `config.callsLimit` 相等
- `M5.goal_hardlimit_match`：`Goal.md` 终止判据里的 `>N calls` 与 `config.callsHardLimit` 相等

## 最后两条为什么存在

它们**把判据文本本身当作被审计对象**。真实发生过：`Goal.md` 的 E4 已改为 200，但 FAILED 那行还写着旧的 `96 calls`——数据全达标，按判据却该判 FAILED。

未来的 LLM 最常犯的不是算错，而是**完成了工作却没对齐判据**。这两条机械比对能兜住。

## 如何新增一条判据

1. 在 `Goal.md` 里写清楚阈值与口径；
2. 在 `audit.mjs` 里加一个 `add(id, ok, detail)`；
3. 能自动算的必须自动算，**不允许"人工确认"式判据**；
4. 若该判据依赖 `Goal.md` 的文本数值，同时加一条逐字比对（同 M5 两条）。

## 设计约定

- **空检查集不等于通过**：没有快照时 `M4.overlap_median` 会明确 FAIL，而不是静默跳过。
- **不修改数据来让检查通过**。历史上所有失败项都保留原状并记录原因。
- 判定逻辑与 `verdict` 写入是同一份 `summary` 对象，避免"打印的和存下来的不一致"。
