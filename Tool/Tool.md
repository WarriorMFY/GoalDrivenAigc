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
# ① 感知：目标差距。读 History\state.json 的 verdict / gap_strict
node Tool\bili\sensor.mjs --print

# ② 归因：本周评论逐条赞数 + 与总获赞交叉核对
node Tool\bili\ledger.mjs report

# ③ 二者不一致时回查评论
node Tool\bili\ledger.mjs sync --pages 10

# ④ 审计判定数据是否可信（AGENTS.md §2 的机器检查）
node Tool\bili\audit.mjs
```

`audit.mjs` 退出码非 0 → 判定数据不可信，**不得据此做决策**，按人在环升级。

`verdict = PASS` → 终止 LOOP。否则按 `gap_strict` 规划。

---

## 2. 工具清单

| 工具 | 职责 | 输出 |
|---|---|---|
| `Tool\bili\sensor.mjs` | 取账号总获赞，算增量/差距/判定 | `History\state.json`、`History\history.ndjson` |
| `Tool\bili\ledger.mjs` | 登记评论、回查逐条赞数、交叉核对 | `History\comments.ndjson`、`History\ledger.json` |
| `Tool\bili\audit.mjs` | 审计判定数据是否由脚本产出、是否自洽 | 无（只读，退出码 1 表示不可信） |
| `Tool\bili\hunt.mjs` | 猎取"评论还能抢前排"的高热度 AI 视频 | `History\candidates.json` |
| `Tool\bili\proven.mjs` | 把已获赞评论收进资产库（供适配复用） | `History\proven.ndjson` |
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

- `verdict`：`PASS` / `GAP` / `NOT_STARTED`（未进时间窗）/ `FAILED`（窗口结束未达标）/ `UNKNOWN`（取数失败）。
- **PASS 用严格下界**：`delta_strict >= target` 才成立。`delta_strict` 取多次采样中最小者减基准，即"哪怕最陈旧的缓存节点也认账"。不要为了好看改成用最大值。
- `reliable = false` → 说明采样极差超过目标的 20%，此指标不足以判定，**升级人工**，改用台账口径。
- 台账交叉核对：`unexplained_likes = 总获赞增量 − 台账 sum_like`。
  - `≈ 0` → 增长全部来自本周评论，归因干净；
  - `> 0` → 多出的赞来自旧评论/动态/相册，**不算本周战绩**；
  - `< 0` → 有赞被取消或基准漂移。
- 基准存在 `state.json` 里，**不在 config**。误删 `state.json` 会丢 t0，必须重跑 `--set-baseline`（会丢历史起算点，慎用）。

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

## 8. 当前状态（截至 2026-10-19 16:20，**仅供参考，必须重跑确认**）

- 账号 mid `326452892`（"为做真实的自己许诺"），粉丝 6，0 视频 / 0 专栏 / 1 动态
- 基准获赞 **4**（`2026-10-19T15:54:51+08:00` 建立），目标 **+50**，即总获赞到 54
- 时间窗 `2026-10-19 ~ 2026-10-25`，剩余 **6.3 天**；最后一批发布截止 **10-23**（预留 48h 发酵）
- 台账 2 条（`BV1x8HD63EvA` 赞 0、`BV19pJY6NEuz` 赞 0），归因干净
- **结构性发现**：B 站评论区默认按热度排序，0 赞新评论必然沉底。实测在 1,785 条评论的视频里，5 页/100 条翻不到自己的评论；只有切"最新"才在第 1 位。→ 顶层评论必须**抢早**（视频 0–3 小时内）。
- **有效位置**：楼中楼（回复热评）。实测同一视频楼中楼回复可得 **30–144 赞**（根评论 929 赞下最高回复 144），且楼层内仅 3–5 条竞争者。台账已支持 `--root` 追踪。
- 判定 **GAP**，`reliable=true`，噪声 NONE，`audit` 18 项通过
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
