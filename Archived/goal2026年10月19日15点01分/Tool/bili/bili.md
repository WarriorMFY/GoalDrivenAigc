# bili.md —— B站工具详细文档

> 本文件记录 B站相关工具的详细用法、接口实测、判定规则。
> 通用流程请参阅 `Tool\Tool.md`。

---

## 1. 工具清单

| 工具 | 职责 | 输出 |
|---|---|---|
| `ledger.mjs` | **判定权威**：登记评论、回查逐条赞数、求本周评论获赞 | `History\comments.ndjson`、`History\ledger.json` |
| `sensor.mjs` | 监控"内容获赞"（不含评论获赞），仅用于发现异常 | `History\state.json`、`History\history.ndjson` |
| `hunt.mjs` | 猎取候选视频（热区/小播放/冷启动三种模式） | `History\candidates_*.json` |
| `hotthread.mjs` | **楼中楼目标**：按"楼内回复战绩 + 根评论增速"找正在分曝光的热楼 | `History\hotthreads.json`、`History\hotthread_history.ndjson` |
| `proven.mjs` | 把已获赞评论收进资产库（供适配复用） | `History\proven.ndjson` |
| `audit.mjs` | 审计判定数据是否由脚本产出、是否自洽 | 无（只读，退出码 1 表示不可信） |
| `config.json` | mid / 目标 / 时间窗 / 采样参数 | 供上述两者读取 |

---

## 2. sensor.mjs 详细用法

```powershell
node Tool\bili\sensor.mjs                    # 常规感知
node Tool\bili\sensor.mjs --print            # 附加人读摘要
node Tool\bili\sensor.mjs --set-baseline     # 以当前值重置基准（只在新周期开始时用！）
node Tool\bili\sensor.mjs --samples 8 --spacing 300
node Tool\bili\sensor.mjs --mid 123 --out "$env:TEMP\x"   # 试跑，不污染 Goal/
```

退出码：`0` 成功（含 GAP/PASS）· `2` 取数失败 · `3` 未配置 mid。

---

## 3. ledger.mjs 详细用法

```powershell
node Tool\bili\ledger.mjs add --bvid BV1xxxxxxxxx --rpid 123456789 --text "评论原文"
node Tool\bili\ledger.mjs add --bvid BV... --rpid 123 --style short-punch --thread-size 264  # 带归因标签
node Tool\bili\ledger.mjs add --bvid BV... --rpid 123 --at "2026-10-19T16:00:21+08:00"  # 补登历史评论
node Tool\bili\ledger.mjs add --bvid BV... --rpid 123 --root 456                        # 楼中楼（回复热评）
node Tool\bili\ledger.mjs sync --pages 10          # 回查赞数
node Tool\bili\ledger.mjs set --rpid 123 --like 7  # 手工修正（脚本抓不到时兜底）
node Tool\bili\ledger.mjs label --rpid 123 --style long-arg --thread-size 555            # 只补标签/纠时间
node Tool\bili\ledger.mjs report                   # 汇总 + 交叉核对
node Tool\bili\ledger.mjs list
```

⚠ **`add` 是登记/重置语义**：对同一 rpid 重复 `add` 会清空它的赞数历史（与 `audit.mjs` 的独立重放一致，见 `DECISIONS.md` D4）。只想补标签或纠正 `posted_at`，用 `label`。

`--style` 建议值：`short-punch`（短梗/一句反转）·`long-arg`（长论证）·`question`·`info`。标签只用于规划归因，**不进判定**。

退出码：`0` 成功 · `2` 取数/解析失败 · `3` 参数错误。

---

## 4. hotthread.mjs 详细用法

把"楼中楼策略"变成可复现的目标清单：`/x/v2/reply?sort=2` 匿名可取每条视频热度前 3 的根评论，`/x/v2/reply/reply?root=` 再取楼内每条回复的赞数（**楼内战绩**）。

```powershell
node Tool\bili\hotthread.mjs --print                          # 扫现有候选，列出最值得回复的热楼
node Tool\bili\hotthread.mjs --golden --print                 # 只留爆炸楼：发布≤12h、楼内≤4、增速≥15 赞/h
node Tool\bili\hotthread.mjs --min-like 30 --max-rcount 4 --max-age 72 --min-root-velocity 20
node Tool\bili\hotthread.mjs --bvid BV1xx,BV1yy               # 指定视频，不读候选文件
node Tool\bili\hotthread.mjs --include-commented              # 允许含本周已评论过的视频
```

### 评分公式（v3）

```
proof     = reply_median*2.5 + reply_max*0.8 + reply_ge10*3   ← 楼内回复真的拿到赞
exposure  = root_like * 0.35
explosion = 根评论增速（赞/小时）：快照差分优先 → root_like/root_age_hours 兜底
freshness = clamp(explosion/50, 0.15, 2.0)（无增速时退回 clamp(播放速度/5000, 0.2, 1.5)）
slot      = 1/(1 + 0.5*max(0, rcount+1-4))                    ← 实测第 4 位仍有 7.58 赞/h（D7）
opportunity = (exposure + proof + 1) * freshness * slot
```

两次修正的历史（别退回去）：
- **v1** 用 `root_like/(rcount+1)`，方向错了——根评 264 赞的楼回复拿 16/11/7 赞，根评 555 赞的楼回复全 1 赞
- **v2** 只按播放速度估新鲜度
- **v3** 改成根评论增速，因为实测 330 赞的爆炸楼让我们第 4 位的回复拿到 7.58 赞/小时，而 6 小时前发在顶层/死楼的 5 条合计 3 赞

`target` 里带 `reply_texts`（楼内已有人说的话）——写草稿前必看，避免撞梗。默认跳过 `ledger.json` 里本周已评论过的视频（避免同一视频反复发评论）。

退出码：`0` 成功 · `2` 全部取数失败 · `3` 无候选（先跑 `hunt` 或 `--bvid`）。

---

## 5. 判定规则

### 5.1 为什么判定只认台账

**B 站主页/接口的"获赞"不含评论获赞。** 实测三例：

| 用户 | 其单条评论赞数 | 主页 `like_num` | 作品构成 |
|---|---|---|---|
| 吴哲offical | 3,160 | **195** | 45 视频 / 4 动态 |
| 苹果拯救了我的一生 | 937 | **426** | 1 视频 / 35 动态 |
| 青山Aoyamakun | 563 | 65,262 | 1,071 视频 |

主页"获赞"统计的是**视频 / 专栏 / 动态 / 相册等内容的获赞**。本账号 0 视频，`like_num` 恒为 4（来自 1 条图文动态），与评论获赞毫无关系。

→ **`sensor.mjs` 的 `card.like_num` 不能用于本目标判定**，已降级为"内容获赞噪音监控"。
→ 唯一判定口径：`ledger.mjs` 统计**本周发布的评论各自的赞数之和**（`comment_like_sum`）。

### 5.2 判定规则

- `verdict`（写在 `History\ledger.json`）：`PASS` / `GAP` / `NOT_STARTED`（未进时间窗）/ `FAILED`（窗口结束未达标）。
- **PASS 条件**：`sum_like >= target`。没有"严格下界"之说——台账读的是每条评论的真实赞数，不是带缓存的聚合值。
- `gap = max(0, target - sum_like)`，规划时用它。
- 归因天然干净：台账只统计本周发布的评论，旧评论/动态的赞不会混入。
- `content_like_delta` 仅作监控：若它突然上涨，说明有视频/动态获赞，**不计入目标**。
- 基准与时间窗：窗口来自 `config.json`，起算日由 `posted_at` 决定；资产评论若不是本周发布，不计入。

### 5.3 常见误判

| 现象 | 正确处理 |
|---|---|
| 主页获赞涨了，评论赞没涨 | 是内容获赞，不计入；看台账 |
| 台账 sum_like 为 0 但感觉"应该有赞" | 评论可能已沉底不入统计，或赞被取消；用 `sync` 复核 |
| 某条评论 MISSING | 楼层被折叠/评论被删；用 `set --rpid --like` 手工补，并在备注说明 |

---

## 6. 每轮 LOOP 标准动作

```
1. node Tool\bili\ledger.mjs report     # ← 判定来源：verdict / gap / missing
   node Tool\bili\sensor.mjs --print    # ← 仅监控：内容获赞异常上涨才需要关注
2. verdict=UNKNOWN / 取数失败        → 人工升级
   unreliable（sensor reliable=false）→ 监控不可信，但判定仍看台账；记录即可
   verdict=PASS                      → 终止
   verdict=GAP                       → 读 ledger 的 gap 继续
3. 同时看 report 的未定位评论（MISSING）与 content_like_delta（异常上涨=有非评论来源的赞）
4. 有新评论 → add + sync；无 → 规划下一步
5. verdict=GAP → 人在线时立刻走即时通道（**不排队**）：
              node Tool\bili\hunt.mjs --min-view 2000 --max-age 14   # 抓当天新视频
              node Tool\bili\hotthread.mjs --golden --print          # 只留爆炸楼（增速 ≥15 赞/h）
              看 reply_texts 防撞梗 → 草稿写进 Tool\inbox\drafts.md → 当场发 → 立刻 add + sync

   ⚠ **发成顶层是最大的人为损耗**：给用户的指令必须写"点目标根评论下方的『回复』"。
   2026-10-19 23:29 的 `BV1wKJd6LEej` 就发成了顶层（root_id = 自身 rpid），等于放弃了曝光继承。
   验收方法：`add` 输出的"层级"必须是 `楼中楼（root=…）`，出现 `顶层评论` 就说明发错了位置。
```

**人在环升级条件**：取数连续失败、评论 MISSING、`content_like_delta` 异常上涨（说明有非评论来源的赞）、时间窗内剩余天数不足而 gap 仍大。

---

## 7. 关键实证与发现

### 7.1 结构性发现

默认按热度排序 → 顶层新评论必然沉底；楼中楼继承根评论曝光。

### 7.2 量级实证（最重要）

楼中楼 **7.58 赞/小时** vs 顶层 **0.15 赞/小时**，差 **50 倍**。

6 小时前发在顶层/死楼的 5 条评论合计 3 赞，1 条爆炸楼的楼中楼一夜 5 赞。

### 7.3 位置实证

同一楼内 5 条回复 `21/15/11/5/1` 赞，全是同梗系，差距来自发布时刻；我们排第 4 位仍有 7.58 赞/小时 → 位置重要但不是断崖（D7 把 SLOT_FULL 放宽到 4）。

### 7.4 冷启动发现

小播放视频的出赞率取决于**评论率**（实测 2,643 播放/42 评论/评论率 15.9‰ 的视频，热评 84 赞），教程类仅 1 赞。

### 7.5 热楼实证

`/x/v2/reply?sort=2` 匿名可拿到每条视频热度前 3 的根评论 → 已沉淀为 `hotthread.mjs`（v3）。

### 7.6 正例/反例

- 根评 264 赞的楼回复拿 16/11/7 赞
- 根评 555 赞的楼回复全 1 赞
- 根评 330 赞的爆炸楼第 4 位拿 5 赞/0.66h

### 7.7 风格归因（n=7，仅方向参考）

`short-punch` 3 条 4 赞 vs `long-arg` 4 条 0 赞

### 7.8 题材实证

猎手已会拉标签核验，`BV19XJi63ETA`（"你说说这ai怎么取代人类？"）标签为搞笑/奇葩，属标题党，已剔除。

---

## 8. 待建 / 已知缺口

1. **发布通道**：还没有"发评论"动作，依赖用户手动发布并把链接交回（无登录态，也不打算获取）。
2. **题材匹配**：有了资产库后，需要把"已获赞评论的题材/结构"与"猎手候选视频"自动配对，产出 `History\matches.json`，目前靠人读。
3. **猎手小缺陷**：`hunt` 若筛出 0 条仍会覆盖 `candidates.json`，会丢上一轮的好结果，建议保留最近非空快照。
4. **`hunt` 热区模式选品偏窄**：`minView` 20000 卡出的多是 1–3 万播放的 AIGC 创作赛视频；真正的高流量候选靠旧快照漏进来的。
   23:18 用 `--min-view 2000 --max-age 14` 只筛出 3 条 → 需要按"流量速度"而不是"累计播放"选品。
5. **回复胜出样本库（`DECISIONS.md` D9）尚未建**：同楼内 21/15/11/5/1 的差异到底是"结构"还是"时刻"，目前只有假设、没有统计。要跑够 300+ 条楼内回复样本才能下结论。
6. **评论赞数的时间曲线没有专门命令**：`comments.ndjson` 里其实有完整 sync 历史，但没有 `trend` 视图，"评论第 N 小时涨了多少"目前只能手翻事件日志。
7. **`hotthread_history.ndjson` 刚建**（23:24 首行），`root_velocity` 要等第二次运行才有差分值。

---

## 9. 探查纪律

> 规则原文：**所有用于判定的数据必须由 `Tool\` 下的脚本产出；一次性命令只允许探查（只读），不得作为判定依据。**

### 允许

用一次性命令摸清"接口长什么样"：试路径、看字段名、验证是否可用、估算分页规模。

```powershell
# 例：确认某接口返回什么
node -e "fetch('https://api.bilibili.com/...').then(r=>r.json()).then(j=>console.log(Object.keys(j.data)))"
```

### 禁止

| 行为 | 为什么不行 |
|---|---|
| 把一次性命令的输出当作"当前差距/赞数"汇报 | 无留痕、不可复现、无法审计 |
| 手抄数字写进 `History\*.json` | 违反 AGENTS.md §1「禁止手写世界状态」 |
| 用一次性命令发帖、点赞、修改账号状态 | 违反 §2「只能通过 Tool\ 下的脚本改变世界」 |
| 探查成功后只在对话里记一笔，不沉淀成脚本 | 下一轮或新会话要从零重试 |

### 沉淀要求

探查有结论后，**当轮**把它写成 `Tool\bili\<name>.mjs`，再让判定依赖该脚本的落盘产物。

### 判定数据白名单

**判定只认一个文件**：`History\ledger.json`（由 `ledger.mjs` 写）。它提供 `verdict` / `sum_like` / `gap` / `missing` / 逐条明细。

`History\state.json`（`sensor.mjs` 写）**不是判定数据**，只是监控：`like_num`（内容获赞）、`reliable`、`delta`。它的 `verdict` / `gap_strict` / `delta_strict` 一律不得作为"够不够"的依据——B 站主页获赞不含评论获赞，这条口径换算过来就是 50 赞对不上（见 §5.1）。

两者的脚本产出属性与自洽性，由 `Tool\bili\audit.mjs` 机器校验（21 项：字段齐全、`source` 标记、verdict 合法、history 末行与 state 同源、台账与事件日志按同一窗口口径一致、配置未漂移）。

实测能抓到：手写 `like_num`、伪造 `PASS`、手改 `sum_like`、删字段、重复 `add` 造成的口径错位。

### 自检

任何"涨了多少 / 够不够 / 达没达标"的结论，必须能同时回答：

1. 数字来自哪个文件的哪个字段？（判定只能来自 `ledger.json`）
2. 是哪个命令生成的？重跑一次能否复现？

答不出来，就说明这个结论是探查结果，不能用于判定。
