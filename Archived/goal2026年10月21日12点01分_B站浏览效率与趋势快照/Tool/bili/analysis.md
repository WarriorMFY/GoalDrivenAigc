# analysis.md —— 分析层（delta.mjs / trend.mjs）

> 一句话：把官方快照与流样本变成"能读的结论"——趋势总表、快照 diff、压缩对照实验、小时级序列。
> 索引见 [../Tool.md](../Tool.md)；**口径规则必须先读 [data-model.md](data-model.md)**。

## delta.mjs

```powershell
node Tool\bili\delta.mjs report --write          # 趋势总表 → History\trend_report.md
node Tool\bili\delta.mjs pair <stampA> <stampB>  # 两份快照详细 diff → History\delta_A_B.json
node Tool\bili\delta.mjs exp                     # E6 对照实验 → History\exp_compress.json
```

### `report`
生成 5 段内容：总表（时段/实际/条目/digest/压缩/重合/新进/掉榜）、重合度中位数、逐组涨幅榜（cohort 口径 Top5）、新进/掉榜各 5 条、以及每组的共同条目数。

**只统计 `src=ranking` 的行**（全站排行），因为它是唯一跨时段可比的对象。

### `pair`
对两份快照的排行 Top50 做集合运算：
- `overlap = |A∩B| / |A|`
- `added` / `dropped` / `grows`（共同条目按 `view` 增量排序）

这是"M4 相邻重合度"的数据来源，也是人工核查某次大换血的首选工具。

### `exp`
E6 对照实验：把**同一时点**的 raw 与 digest 分别估算 token，并抽检 10 条可证伪事实能否从 digest 复原。

实测结果：`raw 75,873 tokens → digest 842 tokens`（**90.1x**），关键事实保留 **10/10**，`retention = 1.0`。
token 估算口径写在结果文件里：CJK 1 字 ≈ 1 token，其余 3.5 字符 ≈ 1 token（非计费口径，只用于相对比较）。

## trend.mjs

```powershell
node Tool\bili\trend.mjs --write --tail 12   # 小时级序列 → History\trend_log.md
```

输出四段：小时级聚合、full 序列（cohort 口径）、事件统计、最近 N 条样本。

### 关键约定：**按池分行**

小时表是「小时 × 池」两维，`light` 与 `full` 各占一行。**曾经把两个池混合平均**，得到"截面 view 均值 7092 万"这种毫无意义的数字（4900 万与 9200 万的平均）。这是跨池聚合的第 N 次复发。

### full 序列是唯一可跨时段比较的增速线

只列 `kind=full` 且 `cohortPct != null` 的样本，字段：时刻 / cohort 条数 / 增量 / 增速 / 重合 / 峰值增速。

**这是全项目最有价值的一条曲线**：它剔除了换血污染，暴露了真实日内规律——凌晨 +0.18%、上午 +0.30%、午间 +0.60%、傍晚 +0.65%（%/30min）。

## 两个工具的已知边界

1. **样本第一条没有 prev**：`trend_log.md` 中首条样本的 `added` 是全量（50），会在"换血累计"里虚高。引用时需排除每个池的第一条。
2. **盲区后的样本不可用**：休眠恢复后的第一条样本 cohort 是跨小时累积的。`trend_log.md` 不做剔除（保留原貌），引用时须人工排除。
3. `report` 的"相邻"取决于快照密度：若只剩 2 份快照，二者的间隔可能跨夜，重合度低不代表漂移大。
