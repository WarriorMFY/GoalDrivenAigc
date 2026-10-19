# Tool.md —— 执行器契约 / 冷启动手册

> 本文件是"世界"的工具层入口。**新建对话或清理上下文后，先读这一页，再读 `Goal\Goal.md`，然后跑一次感知器**，不要相信本文末尾的状态快照。
>
> 对应 `AGENTS.md` 的 LOOP：`感知差距[Sensor] → 规划 → 执行[Tool] → 重新感知`，终止条件 `verdict = PASS`。
>
> **要改工具，先读 `Tool\DECISIONS.md`**（为什么这样设计、代价、回滚方式），改完必须在里面补一条。

---

## 0. 一句话现状

感知器（总获赞）、台账（逐条评论赞数）、猎手（找视频）、热楼猎手（找正在爆炸的楼，v3）已建成并跑通；**"发评论"仍是人工环节**（无登录态，也不打算获取）。**不走待发布队列**——热楼窗口以小时计，等你打开就过期了。

---

## 1. 冷启动：30 秒

```powershell
# ① 判定（唯一权威）：本周评论累计获赞 → 读 History\ledger.json 的 verdict
node Tool\bili\ledger.mjs report

# ② 偏差监控（不参与判定）：账号"内容获赞"，仅用于发现异常
node Tool\bili\sensor.mjs --print

# ③ 有新评论待回查时
node Tool\bili\ledger.mjs sync --pages 10

# ④ 审计判定数据是否可信（AGENTS.md §2 的机器检查）
node Tool\bili\audit.mjs
```

`ledger.json` 的 `verdict` 才是 LOOP 的判定；`state.json` 只是监控（它的 `verdict`/`gap_strict` 一律不作判据）。

`verdict = PASS` → 终止 LOOP；否则按 **`ledger.json` 的 `gap`** 规划（不是 `state.json` 的 `gap_strict`）。

---

## 2. 工具清单

| 工具 | 职责 | 输出 |
|---|---|---|
| `Tool\bili\ledger.mjs` | **判定权威**：登记评论、回查逐条赞数、求本周评论获赞 | `History\comments.ndjson`、`History\ledger.json` |
| `Tool\bili\sensor.mjs` | 监控"内容获赞"（不含评论获赞），仅用于发现异常 | `History\state.json`、`History\history.ndjson` |
| `Tool\bili\hunt.mjs` | 猎取候选视频（热区/小播放/冷启动三种模式） | `History\candidates_*.json` |
| `Tool\bili\hotthread.mjs` | **楼中楼目标**：按"楼内回复战绩 + 根评论增速"找正在分曝光的热楼 | `History\hotthreads.json`、`History\hotthread_history.ndjson` |
| `Tool\bili\proven.mjs` | 把已获赞评论收进资产库（供适配复用） | `History\proven.ndjson` |
| `Tool\bili\audit.mjs` | 审计判定数据是否由脚本产出、是否自洽 | 无（只读，退出码 1 表示不可信） |
| `Tool\bili\config.json` | mid / 目标 / 时间窗 / 采样参数 | 供上述两者读取 |

### sensor.mjs

```powershell
node Tool\bili\sensor.mjs                    # 常规感知
node Tool\bili\sensor.mjs --print            # 附加人读摘要
node Tool\bili\sensor.mjs --set-baseline     # 以当前值重置基准（只在新周期开始时用！）
node Tool\bili\sensor.mjs --samples 8 --spacing 300
node Tool\bili\sensor.mjs --mid 123 --out "$env:TEMP\x"   # 试跑，不污染 Goal/
```

退出码：`0` 成功（含 GAP/PASS）· `2` 取数失败 · `3` 未配置 mid。

### ledger.mjs

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

⚠ **`add` 是登记/重置语义**：对同一 rpid 重复 `add` 会清空它的赞数历史（与 `audit.mjs` 的独立重放一致，
见 `DECISIONS.md` D4）。只想补标签或纠正 `posted_at`，用 `label`。
`--style` 建议值：`short-punch`（短梗/一句反转）·`long-arg`（长论证）·`question`·`info`。
标签只用于规划归因，**不进判定**。

退出码：`0` 成功 · `2` 取数/解析失败 · `3` 参数错误。

### hotthread.mjs

把 §8 的"楼中楼策略"变成可复现的目标清单：`/x/v2/reply?sort=2` 匿名可取每条视频热度前 3 的根评论，
`/x/v2/reply/reply?root=` 再取楼内每条回复的赞数（**楼内战绩**）。

```powershell
node Tool\bili\hotthread.mjs --print                          # 扫现有候选，列出最值得回复的热楼
node Tool\bili\hotthread.mjs --golden --print                 # 只留爆炸楼：发布≤12h、楼内≤4、增速≥15 赞/h
node Tool\bili\hotthread.mjs --min-like 30 --max-rcount 4 --max-age 72 --min-root-velocity 20
node Tool\bili\hotthread.mjs --bvid BV1xx,BV1yy               # 指定视频，不读候选文件
node Tool\bili\hotthread.mjs --include-commented              # 允许含本周已评论过的视频
```

评分（v3，决策见 `DECISIONS.md` D1 / D7）：

```
proof     = reply_median*2.5 + reply_max*0.8 + reply_ge10*3   ← 楼内回复真的拿到赞
exposure  = root_like * 0.35
explosion = 根评论增速（赞/小时）：快照差分优先 → root_like/root_age_hours 兜底
freshness = clamp(explosion/50, 0.15, 2.0)（无增速时退回 clamp(播放速度/5000, 0.2, 1.5)）
slot      = 1/(1 + 0.5*max(0, rcount+1-4))                    ← 实测第 4 位仍有 7.58 赞/h（D7）
opportunity = (exposure + proof + 1) * freshness * slot
```

两次修正的历史（别退回去）：**v1** 用 `root_like/(rcount+1)`，方向错了——根评 264 赞的楼回复拿 16/11/7 赞，
根评 555 赞的楼回复全 1 赞；**v2** 只按播放速度估新鲜度；**v3** 改成根评论增速，
因为实测 330 赞的爆炸楼让我们第 4 位的回复拿到 7.58 赞/小时，而 6 小时前发在顶层/死楼的 5 条合计 3 赞。

`target` 里带 `reply_texts`（楼内已有人说的话）——写草稿前必看，避免撞梗。
默认跳过 `ledger.json` 里本周已评论过的视频（避免同一视频反复发评论）。

退出码：`0` 成功 · `2` 全部取数失败 · `3` 无候选（先跑 `hunt` 或 `--bvid`）。

### ~~todo.mjs~~（已停用，见 `DECISIONS.md` D8）

曾用来产出"待发布队列"（`History\todo.json` + `History\opens.txt`），**已作废并删除产物**：
热楼的窗口以小时计，进队列等人工打开等于把机会放过期。现在的形态是
**你在线 → 当场抓爆炸楼 → 当场写 → 当场发**。脚本文件保留但不在冷启动路径里。

`todo.json` 是派生文件，每次运行覆盖；**草稿的唯一真源是 `Tool\inbox\drafts.md`**。
发布后立刻 `ledger.mjs add --bvid <BV> --rpid <新rpid> --style <style> --thread-size <root_like>`。

---

## 3. 文件地图

| 文件 | 谁写 | 可否手改 |
|---|---|---|
| `Goal\Goal.md` | **仅用户** | LLM 只读，禁止写入 |
| `History\state.json` | sensor | 否（监控快照，**不参与判定**） |
| `History\history.ndjson` | sensor 追加 | 否（审计留痕） |
| `History\comments.ndjson` | ledger 追加 | 否（事件日志，只增；**内含 2026-10-19 22:49 的 7 条重复 `add`**，是标签回填副产物，非数据损坏，见 DECISIONS D4） |
| `History\ledger.json` | ledger 重写 | 否 |
| `History\candidates_*.json` | hunt | 否（派生，可重跑） |
| `History\hotthreads.json` | hotthread | 否（派生，可重跑） |
| `History\hotthread_history.ndjson` | hotthread 追加 | 否（根评论赞数快照，用于算增速；删了就丢增速基线） |
| `History\sensor_error.json` | sensor（仅配置错误时） | 是 |
| `Tool\inbox\drafts.md` | 人 / LLM | **是（草稿唯一真源）** |
| `Tool\bili\config.json` | 人 | 是 |
| `Tool\DECISIONS.md` | 人 / LLM | 是（改工具必须先在此留一条） |

**根目录只允许三个目录：`Goal\`（用户的目标，只读）、`Tool\`（工具与配置）、`History\`（全部机器生成的产物）。** 新增产物一律放进这三棵子树。

---

## 4. 判定规则（不要改口径）

### 4.0 为什么判定只认台账

**B 站主页/接口的"获赞"不含评论获赞。** 实测三例：

| 用户 | 其单条评论赞数 | 主页 `like_num` | 作品构成 |
|---|---|---|---|
| 吴哲offical | 3,160 | **195** | 45 视频 / 4 动态 |
| 苹果拯救了我的一生 | 937 | **426** | 1 视频 / 35 动态 |
| 青山Aoyamakun | 563 | 65,262 | 1,071 视频 |

主页"获赞"统计的是**视频 / 专栏 / 动态 / 相册等内容的获赞**。本账号 0 视频，`like_num` 恒为 4（来自 1 条图文动态），与评论获赞毫无关系。

→ **`sensor.mjs` 的 `card.like_num` 不能用于本目标判定**，已降级为"内容获赞噪音监控"。
→ 唯一判定口径：`ledger.mjs` 统计**本周发布的评论各自的赞数之和**（`comment_like_sum`）。

### 4.1 判定规则

- `verdict`（写在 `History\ledger.json`）：`PASS` / `GAP` / `NOT_STARTED`（未进时间窗）/ `FAILED`（窗口结束未达标）。
- **PASS 条件**：`sum_like >= target`。没有"严格下界"之说——台账读的是每条评论的真实赞数，不是带缓存的聚合值。
- `gap = max(0, target - sum_like)`，规划时用它。
- 归因天然干净：台账只统计本周发布的评论，旧评论/动态的赞不会混入。
- `content_like_delta` 仅作监控：若它突然上涨，说明有视频/动态获赞，**不计入目标**。
- 基准与时间窗：窗口来自 `config.json`，起算日由 `posted_at` 决定；资产评论若不是本周发布，不计入。

### 4.2 常见误判

| 现象 | 正确处理 |
|---|---|
| 主页获赞涨了，评论赞没涨 | 是内容获赞，不计入；看台账 |
| 台账 sum_like 为 0 但感觉"应该有赞" | 评论可能已沉底不入统计，或赞被取消；用 `sync` 复核 |
| 某条评论 MISSING | 楼层被折叠/评论被删；用 `set --rpid --like` 手工补，并在备注说明 |

---

## 5-6. 接口实测清单 / 分享链接 → rpid

已拆到 **`Tool\bili\API-NOTES.md`**（可用接口、踩坑表、评论定位硬约束、短链解析）。
新增实测结论请追加到那里，本手册保持精简。

---

## 7. 每轮 LOOP 标准动作

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
（`unexplained_likes` 这个字段已不存在——`ledger.mjs` 不再计算它，2026-10-19 清理时统一改为上面的表述。）

---

## 8. 当前状态（截至 2026-10-19 23:45，**仅供参考，必须重跑确认**）

- 账号 mid `326452892`（"为做真实的自己许诺"），粉丝 6，0 视频 / 0 专栏 / 1 动态 / 1 相册
- **口径已修正**：主页"获赞 4"是内容获赞（来自 1 条图文动态），**与评论无关**；判定改用台账
- 本周评论 **9 条**，评论获赞 **7**，判定 **GAP**，距目标 **43**，`audit` 21 项通过（截至 23:32）
  - `BV1x8HD63EvA` 顶层 [long-arg] · 0 赞
  - `BV19pJY6NEuz` 顶层 [short-punch]（1,785 评论，已沉底）· 1 赞
  - `BV1VMJi6GErN` 顶层 600 字 [long-arg]（位置差且过长）· 0 赞
  - `BV1VMJi6GErN` 楼中楼 [short-punch]（root=317400656849，555 赞根评论）· 1 赞
  - `BV15hn365E6F` 顶层 [long-arg] · 0 赞
  - `BV1ceJi6sEzZ` 顶层 [long-arg] · 0 赞
  - `BV1wenJ65EFG` 楼中楼 [short-punch]（root=317558392545，264→330 赞）· **5 赞 / 0.66h = 7.58 赞每小时**
  - `BV1ZLJd6MEfo` 楼中楼 [short-punch]（root=317569609425，78→84 赞，楼内第 2 位）· 0 赞（23:28 发布）
  - `BV1wKJd6LEej` **顶层** [short-punch] · 0 赞（23:29 发布，**发错层级**：本应回 root=321235825184）
- 资产库 2 条（8 赞、1 赞），均为上周发布，不计入本周
- 时间窗 `2026-10-19 ~ 2026-10-25`，剩余 **5.8 天**；最后发布截止 **10-23**
- **结构性发现**：默认按热度排序 → 顶层新评论必然沉底；楼中楼继承根评论曝光
- **量级实证（最重要的一条）**：楼中楼 **7.58 赞/小时** vs 顶层 **0.15 赞/小时**，差 **50 倍**。
  6 小时前发在顶层/死楼的 5 条评论合计 3 赞，1 条爆炸楼的楼中楼一夜 5 赞。
- **位置实证**：同一楼内 5 条回复 `21/15/11/5/1` 赞，全是同梗系，差距来自发布时刻；
  我们排第 4 位仍有 7.58 赞/小时 → 位置重要但不是断崖（D7 把 SLOT_FULL 放宽到 4）
- **冷启动发现**：小播放视频的出赞率取决于**评论率**（实测 2,643 播放/42 评论/评论率 15.9‰ 的视频，热评 84 赞），教程类仅 1 赞
- **热楼实证**：`/x/v2/reply?sort=2` 匿名可拿到每条视频热度前 3 的根评论 → 已沉淀为 `hotthread.mjs`（v3）
- **正例/反例**：根评 264 赞的楼回复拿 16/11/7 赞；根评 555 赞的楼回复全 1 赞；根评 330 赞的爆炸楼第 4 位拿 5 赞/0.66h
- **风格归因（n=7，仅方向参考）**：`short-punch` 3 条 4 赞 vs `long-arg` 4 条 0 赞
- **22:49 建的待发布队列已作废**（D8）：删掉 `todo.json` / `opens.txt`，改回"你在线→当场抓楼→当场写→当场发"
- **题材实证**：猎手已会拉标签核验，`BV19XJi63ETA`（"你说说这ai怎么取代人类？"）标签为搞笑/奇葩，属标题党，已剔除
- 资产库 `History\proven.ndjson` 待建（等用户在 `Tool\inbox\proven-links.md` 贴入已获赞评论链接）

---

## 9. 待建 / 已知缺口

1. **发布通道**：还没有"发评论"动作，依赖用户手动发布并把链接交回（无登录态，也不打算获取）。
2. **题材匹配**：有了资产库后，需要把"已获赞评论的题材/结构"与"猎手候选视频"自动配对，产出 `History\matches.json`，目前靠人读。
3. **猎手小缺陷**：`hunt` 若筛出 0 条仍会覆盖 `candidates.json`，会丢上一轮的好结果，建议保留最近非空快照。
4. **`hunt` 热区模式选品偏窄**：`minView` 20000 卡出的多是 1–3 万播放的 AIGC 创作赛视频；真正的高流量候选靠旧快照漏进来的。
   23:18 用 `--min-view 2000 --max-age 14` 只筛出 3 条 → 需要按"流量速度"而不是"累计播放"选品。
5. **回复胜出样本库（`DECISIONS.md` D9）尚未建**：同楼内 21/15/11/5/1 的差异到底是"结构"还是"时刻"，
   目前只有假设、没有统计。要跑够 300+ 条楼内回复样本才能下结论。
6. **评论赞数的时间曲线没有专门命令**：`comments.ndjson` 里其实有完整 sync 历史，但没有 `trend` 视图，
   "评论第 N 小时涨了多少"目前只能手翻事件日志。
7. **`hotthread_history.ndjson` 刚建**（23:24 首行），`root_velocity` 要等第二次运行才有差分值。

---

## 10. 红线

不做、也不写进任何工具：多账号、互赞群、刷赞、脚本模拟点击、盗用他人 cookie。
赞必须来自真实用户对真实评论的自发认可。

---

## 11. 探查纪律（AGENTS.md §2 的落地细则）

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

`History\state.json`（`sensor.mjs` 写）**不是判定数据**，只是监控：`like_num`（内容获赞）、`reliable`、`delta`。它的 `verdict` / `gap_strict` / `delta_strict` 一律不得作为"够不够"的依据——B 站主页获赞不含评论获赞，这条口径换算过来就是 50 赞对不上（见 §4.0）。

两者的脚本产出属性与自洽性，由 `Tool\bili\audit.mjs` 机器校验（21 项：字段齐全、`source` 标记、verdict 合法、history 末行与 state 同源、台账与事件日志按同一窗口口径一致、配置未漂移）。
实测能抓到：手写 `like_num`、伪造 `PASS`、手改 `sum_like`、删字段、重复 `add` 造成的口径错位。

### 自检

任何"涨了多少 / 够不够 / 达没达标"的结论，必须能同时回答：

1. 数字来自哪个文件的哪个字段？（判定只能来自 `ledger.json`）
2. 是哪个命令生成的？重跑一次能否复现？

答不出来，就说明这个结论是探查结果，不能用于判定。
