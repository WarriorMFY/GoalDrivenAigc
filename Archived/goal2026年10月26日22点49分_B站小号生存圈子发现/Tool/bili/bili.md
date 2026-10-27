# bili —— B 站圈子感知工具（本目标专用精简版）

> 索引见 `Tool\Tool.md`。本文件只讲**怎么用**与**口径从哪来**；口径的唯一权威是 `Goal\Goal.md`（仅用户可写）。

## 1. 四个脚本的职责

| 脚本 | 职责 | 改世界？ |
|---|---|---|
| `probe.mjs` | 接口探查：search/card/view 可用性、字段形状、风控命中 | 否（只写 `History\probes\`） |
| `collect.mjs` | 取样：按关键词簇取 pubdate 最新投稿 → 反查作者粉丝/投稿数 → 挑出新号作品 → 取权威 stat | 否（只写 `History\samples\`、`History\cache\`） |
| `sensor.mjs` | 感知/判定：算每簇 n0 与 M_R → 出 `verdict.json` / `latest.md` | 否（只写 `History\`） |
| `audit.mjs` | 留痕审计：口径标签、粉丝直方图、sha256 与索引一致性、新鲜度 | 否（只写 `History\audits\`） |

四个脚本都**不写 Goal、不写 Tool 之外的地方**；判定数据全部落 `History\`。

## 2. 一轮标准循环

```powershell
node Tool\bili\collect.mjs        # 取样（全量约 6–8 分钟，含限速）
node Tool\bili\audit.mjs          # 可选：先自检样本是否可信
node Tool\bili\sensor.mjs         # 判定 → History\latest.md
```

- `sensor.mjs` 退出码：`0` PASS ｜ `1` GAP/RUNNING ｜ `2` FAILED ｜ `3` 数据不足（INSUFFICIENT）
- 换网络、换关键词前先 `node Tool\bili\probe.mjs`，避免 collect 跑到一半被掐。

## 3. 口径（必须与 Goal.md 一致，改这里前先改 Goal.md）

- **圈子** = 关键词簇（`config.json` 的 `clusters`），判定单位是簇，簇内合并各关键词样本去重。
- **新号作品** = 作者 `card.fans ≤ 100` 且 `archive_count ≤ 20`。
- **互动率 R** = `(like + reply + coin + favorite) / play`，`play = 0` 的作品剔除。
- **簇互动率 M_R** = 该簇新号作品 R 的中位数。
- **簇 PASS** = `n0 ≥ 3` 且 `M_R ≥ 3%`；`n0 < 3` → INSUFFICIENT（不判达标也不判死）。
- **总体** = 任一簇 PASS 即 PASS；窗口结束时无一簇 PASS 即 FAILED。

## 4. 实测约束（踩过的坑，改脚本前必读）

| 约束 | 实证 | 对策 |
|---|---|---|
| 搜索对 0 粉号不收录 | 40 条 pubdate 样本中粉丝最小 6，0 粉 0 条 | 口径改为 `fans≤100 且 投稿数≤20`（已由用户在 2026-10-26 定稿） |
| 搜索连发触发 `HTTP 412` | 2.6s 间隔第 2 个词即 412 | 间隔提到 `8000ms + 随机 2500ms`，`retries=4` |
| `totalrank/click` 排序里没有新号 | 排序按权重，新号必然沉底 | 只用 `order=pubdate` |
| `card` 的 fans 字段位置不固定 | 有的在 `data.card.fans`，老接口在 `data.fans` | `lib.mjs` 两个位置都读 |
| 搜索 `play/like` 可能是 `"1.2万"` 字符串 | 归档实测 | `collect.mjs` 的 `num()` 统一解析 |
| 搜索结果的 `like` 不可靠 | ——— | 只对新号作品调 `view` 取权威 stat（数量少，成本可控） |

## 5. 文件与字段

`History\samples\<stamp>.json`（明细层，脚本读）：

```
{ stamp, at, order, pages, smallDef,
  clusters: [ { id, name, keywords, samples, uniqueAuthors, unknownFans,
                smallSamples, smallWithPlay, medianRate,
                items: [{ bvid, mid, author, keyword, fans, archiveCount, stat, rate }],
                small: [{ bvid, mid, author, fans, archiveCount, pubdate, ageHours, stat:{source,play,like,reply,coin,favorite,danmaku}, rate, title }] } ],
  errors: [...] }
```

`History\verdict.json`（判定层）：`{ overall, passedClusters, clusters:[{id,state,n0,medianRate,reason,top}], window, thresholds }`

`History\latest.md`：≤1.2KB 摘要，**人/LLM 只读这一层**，别把 `samples\*.json` 灌进上下文。

## 6. 归档注意

按 `AGENTS.md` 全局规则 3：目标结束时 `Goal\`、`History\`、`Tool\`（除 `Tool\git`）整体移入 `Archived\goal<开始时间>_<描述>\`；`Skills\` 与 `Tool\git` **不归档**（留作跨目标复用）。
