# Tool.md —— 执行器契约 / 冷启动手册

> 本文件是"世界"的工具层入口。**新建对话或清理上下文后，先读这一页，再读 `Goal\Goal.md`，然后跑一次感知器**，不要相信本文末尾的状态快照。
>
> 对应 `AGENTS.md` 的 LOOP：`感知差距[Sensor] → 规划 → 执行[Tool] → 重新感知`，终止条件 `verdict = PASS`。

---

## 0. 一句话现状

感知器（总获赞）与台账（逐条评论赞数）已建成并跑通；**"发评论"与"找热视频"仍是人工环节**，尚未进工具层。

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

`ledger.json` 的 `verdict` 才是 LOOP 的判定；`state.json` 只是监控。

`verdict = PASS` → 终止 LOOP。否则按 `gap_strict` 规划。

---

## 2. 工具清单

| 工具 | 职责 | 输出 |
|---|---|---|
| `Tool\bili\ledger.mjs` | **判定权威**：登记评论、回查逐条赞数、求本周评论获赞 | `History\comments.ndjson`、`History\ledger.json` |
| `Tool\bili\sensor.mjs` | 监控"内容获赞"（不含评论获赞），仅用于发现异常 | `History\state.json`、`History\history.ndjson` |
| `Tool\bili\hunt.mjs` | 猎取候选视频（热区/小播放/冷启动三种模式） | `History\candidates_*.json` |
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
node Tool\bili\ledger.mjs add --bvid BV... --rpid 123 --at "2026-10-19T16:00:21+08:00"  # 补登历史评论
node Tool\bili\ledger.mjs add --bvid BV... --rpid 123 --root 456                        # 楼中楼（回复热评）
node Tool\bili\ledger.mjs sync --pages 10          # 回查赞数
node Tool\bili\ledger.mjs set --rpid 123 --like 7  # 手工修正（脚本抓不到时兜底）
node Tool\bili\ledger.mjs report                   # 汇总 + 交叉核对
node Tool\bili\ledger.mjs list
```

退出码：`0` 成功 · `2` 取数/解析失败 · `3` 参数错误。

---

## 3. 文件地图

| 文件 | 谁写 | 可否手改 |
|---|---|---|
| `Goal\Goal.md` | **仅用户** | LLM 只读，禁止写入 |
| `History\state.json` | sensor | 否（机器判定用，改了就失真） |
| `History\history.ndjson` | sensor 追加 | 否（审计留痕） |
| `History\comments.ndjson` | ledger 追加 | 否（事件日志，只增） |
| `History\ledger.json` | ledger 重写 | 否 |
| `History\sensor_error.json` | sensor（仅配置错误时） | 是 |
| `Tool\bili\config.json` | 人 | 是 |

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

## 5. 接口实测清单（省下重新试错的时间）

### 可用（免登录）

| 用途 | 接口 |
|---|---|
| 账号总获赞 | `GET /x/web-interface/card?mid=<mid>` → `data.like_num` |
| 账号内容构成 | `GET /x/space/navnum?mid=<mid>` → `video/article/opus` |
| 视频信息 | `GET /x/web-interface/view?bvid=<BV>` → `aid`、`stat`、`pubdate` |
| 最新评论（时间倒序） | `GET /x/v2/reply/main?type=1&oid=<aid>&mode=2&next=<cursor>` |
| 全站热门 | `GET /x/web-interface/popular?ps=50&pn=1` |
| 搜索 | `GET /x/web-interface/search/type?search_type=video&keyword=..&order=pubdate\|click\|totalrank&page=1` |

### 不可用 / 有坑

| 接口或做法 | 现象 | 对策 |
|---|---|---|
| PowerShell `Invoke-WebRequest` 打 B 站 | TLS 层直接失败 `基础连接已经关闭` | **只能用 Node 的 `fetch`**（本机 node v24） |
| PowerShell `Get-Content` 读 `History\*.json` | 按 ANSI 解码 → 中文乱码、`ConvertFrom-Json` 报错 | 用 `node -e` 读，或 `Get-Content -Encoding UTF8`。文件是 UTF-8 无 BOM，**不是文件损坏** |
| 记事本另存 JSON 带上 BOM | `JSON.parse` 会抛 `Unexpected token` | 脚本已内置 `^\uFEFF` 剥离，但仍建议别用记事本改 |
| `GET /x/space/upstat?mid=` | 返回 `{}`，已加 WBI 签名墙，手算 mixin_key 仍为 `{}` | 改用 `card.like_num` |
| `GET /x/msgfeed/like` | `-101 账号未登录` | 需 `SESSDATA`；当前不使用 |
| `GET /x/v2/reply/detail?rpid=` | `-400 请求错误` | **没有按 rpid 单查的接口** |
| `GET /x/v2/reply?...&sort=0`（按时间） | 匿名返回 0 条 | 改用 `reply/main?mode=2` |
| `GET /x/v2/reply?...&sort=2`（热度） | 匿名只给 3 条 | 同上 |
| `GET /x/web-interface/ranking/v2?rid=188` | 返回 2025 年的陈旧视频 | 找热视频别用分区排行 |
| `GET /x/web-interface/dynamic/region?rid=` | `-404` | 无"最新投稿"接口 |
| 搜索接口连发 | 返回 HTML 验证页（风控） | 请求间隔 ≥2s，遇 HTML 重试一次 |
| `like_num` 单次采样 | CDN 多节点双簇，大号实测稳定相差 194 | 已内建多采样；小号（0–39）实测极差恒 0 |

### 评论定位的硬约束

没有按 rpid 单查的接口，只能从"最新评论"往前翻页。匿名首页 17 条、后续每页 20 条。
→ **评论发出后 1 小时内必须 `add` + `sync`**，否则沉底只能靠 `set` 手工补。

---

## 6. 从分享链接到 rpid 的解法

用户常给 `https://b23.tv/xxxxx` 短链，它可能直接是**评论分享链接**，里面就含 rpid：

```powershell
node -e "fetch('https://b23.tv/7GGxgvE',{redirect:'manual'}).then(r=>console.log(r.headers.get('location')))"
# → https://www.bilibili.com/video/BV1x8HD63EvA?comment_on=1&comment_root_id=317539013137...#reply317539013137
```

`BV` 后是 bvid，`#reply` 后是 rpid。若只有视频链接，则用作者 mid + 评论文本在最新评论里匹配。

---

## 7. 每轮 LOOP 标准动作

```
1. node Tool\bili\sensor.mjs --print
2. verdict=UNKNOWN / exit≠0        → 人工升级
   reliable=false                  → 人工升级：指标不可用，切口径 B
   verdict=PASS                     → 终止
   verdict=GAP                      → 读 gap_strict 继续
3. node Tool\bili\ledger.mjs report → 看 unexplained_likes 与未定位评论
4. 有新评论 → add + sync；无 → 规划下一步
```

**人在环升级条件**：取数失败、`reliable=false`、`unexplained_likes > 0`、评论 MISSING、时间窗内剩余天数不足而 gap 仍大。

---

## 8. 当前状态（截至 2026-10-19 17:55，**仅供参考，必须重跑确认**）

- 账号 mid `326452892`（"为做真实的自己许诺"），粉丝 6，0 视频 / 0 专栏 / 1 动态 / 1 相册
- **口径已修正**：主页"获赞 4"是内容获赞（来自 1 条图文动态），**与评论无关**；判定改用台账
- 本周评论 **4 条**，评论获赞 **0**，判定 **GAP**，`audit` 21 项通过
  - `BV1x8HD63EvA` 顶层（4,860 播放，位置无效）
  - `BV19pJY6NEuz` 顶层（1,785 评论，已沉底）
  - `BV1VMJi6GErN` 顶层 600 字（位置差且过长）
  - `BV1VMJi6GErN` 楼中楼（root=317400656849，555 赞根评论，最有希望）
- 资产库 2 条（8 赞、1 赞），均为上周发布，不计入本周
- 时间窗 `2026-10-19 ~ 2026-10-25`，剩余 **6.2 天**；最后发布截止 **10-23**
- **结构性发现**：默认按热度排序 → 顶层新评论必然沉底；楼中楼继承根评论曝光，实测可得 30–144 赞
- **冷启动发现**：小播放视频的出赞率取决于**评论率**（实测 2,643 播放/42 评论/评论率 15.9‰ 的视频，热评 84 赞），教程类仅 1 赞
- **题材实证**：猎手已会拉标签核验，`BV19XJi63ETA`（"你说说这ai怎么取代人类？"）标签为搞笑/奇葩，属标题党，已剔除
- 资产库 `History\proven.ndjson` 待建（等用户在 `Tool\inbox\proven-links.md` 贴入已获赞评论链接）

---

## 9. 待建 / 已知缺口

1. **发布通道**：还没有"发评论"动作，依赖用户手动发布并把链接交回（无登录态，也不打算获取）。
2. **题材匹配**：有了资产库后，需要把"已获赞评论的题材/结构"与"猎手候选视频"自动配对，产出 `History\matches.json`，目前靠人读。
3. **猎手小缺陷**：`hunt` 若筛出 0 条仍会覆盖 `candidates.json`，会丢上一轮的好结果，建议保留最近非空快照。

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

只有这两个文件可以作为判定依据，且只能由脚本写入：

| 文件 | 写入者 | 提供 |
|---|---|---|
| `History\state.json` | `sensor.mjs` | `verdict` / `gap_strict` / `delta_strict` / `reliable` |
| `History\ledger.json` | `ledger.mjs` | `sum_like` / `unexplained_likes` / MISSING |

这两个文件自洽与否，由 `Tool\bili\audit.mjs` 机器校验（18 项：字段齐全、`source` 标记、verdict 合法、history 末行与 state 同源、台账与事件日志一致、配置未漂移）。实测能抓到：手写 `like_num`、伪造 `PASS`、手改 `sum_like`、删字段。

### 自检

任何"涨了多少 / 够不够 / 达没达标"的结论，必须能同时回答：

1. 数字来自哪个文件的哪个字段？
2. 是哪个命令生成的？重跑一次能否复现？

答不出来，就说明这个结论是探查结果，不能用于判定。
