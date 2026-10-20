# API-NOTES —— B 站接口实测清单（从 Tool.md §5/§6 拆出）

> 这是**探查结论沉淀**，不是判据。判定口径见 `Tool.md §4`。
> 新增实测结论请追加到本文件，并在 `Tool.md` 保持一行指针，避免手册越写越厚。

---

## 1. 可用（免登录）

| 用途 | 接口 |
|---|---|
| 账号总获赞 | `GET /x/web-interface/card?mid=<mid>` → `data.like_num` |
| 账号内容构成 | `GET /x/space/navnum?mid=<mid>` → `video/article/opus` |
| 视频信息 | `GET /x/web-interface/view?bvid=<BV>` → `aid`、`stat`、`pubdate` |
| 最新评论（时间倒序） | `GET /x/v2/reply/main?type=1&oid=<aid>&mode=2&next=<cursor>` |
| **楼内回复（带各自赞数）** | `GET /x/v2/reply/reply?type=1&oid=<aid>&root=<rpid>&ps=20&pn=1` |
| 全站热门 | `GET /x/web-interface/popular?ps=50&pn=1` |
| 搜索 | `GET /x/web-interface/search/type?search_type=video&keyword=..&order=pubdate\|click\|totalrank&page=1` |

## 2. 不可用 / 有坑

| 接口或做法 | 现象 | 对策 |
|---|---|---|
| PowerShell `Invoke-WebRequest` 打 B 站 | TLS 层直接失败 `基础连接已经关闭` | **只能用 Node 的 `fetch`**（本机 node v24） |
| PowerShell `Get-Content` 读 `History\*.json` | 按 ANSI 解码 → 中文乱码、`ConvertFrom-Json` 报错 | 用 `node -e` 读，或 `Get-Content -Encoding UTF8`；文件是 UTF-8 无 BOM，**不是文件损坏** |
| 记事本另存 JSON 带上 BOM | `JSON.parse` 抛 `Unexpected token` | 脚本已内置 `^\uFEFF` 剥离，但仍建议别用记事本改 |
| `GET /x/space/upstat?mid=` | 返回 `{}`（WBI 签名墙），手算 mixin_key 仍为 `{}` | 改用 `card.like_num` |
| `GET /x/msgfeed/like` | `-101 账号未登录` | 需 `SESSDATA`；**不使用**（红线：不获取登录态） |
| `GET /x/v2/reply/detail?rpid=` | `-400 请求错误` | **没有按 rpid 单查的接口** |
| `GET /x/v2/reply?...&sort=0`（按时间） | 匿名返回 0 条 | 改用 `reply/main?mode=2` |
| `GET /x/v2/reply?...&sort=2`（热度） | 匿名只给 3 条根评论 | 够用：楼中楼目标只需热度前 3；`hotthread.mjs` 基于此 |
| `GET /x/web-interface/ranking/v2?rid=188` | 返回 2025 年的陈旧视频 | 找热视频别用分区排行 |
| `GET /x/web-interface/dynamic/region?rid=` | `-404` | 无"最新投稿"接口 |
| 搜索接口连发 | 返回 HTML 验证页（风控） | 请求间隔 ≥2s，遇 HTML 重试一次（脚本已内建） |
| `like_num` 单次采样 | CDN 多节点双簇，大号实测稳定相差 194 | 已内建多采样；小号（0–39）实测极差恒 0 |

## 3. 评论定位的硬约束

没有按 rpid 单查的接口，只能从"最新评论"往前翻页。匿名首页 17 条、后续每页 20 条；楼中楼走 `reply/reply?root=`。
→ **评论发出后 1 小时内必须 `ledger.mjs add` + `sync`**，否则沉底只能靠 `set` 手工补。

## 4. 从分享链接到 rpid

用户常给 `https://b23.tv/xxxxx` 短链，它可能直接是**评论分享链接**，里面就含 rpid：

```powershell
node -e "fetch('https://b23.tv/7GGxgvE',{redirect:'manual'}).then(r=>console.log(r.headers.get('location')))"
# → https://www.bilibili.com/video/BV1x8HD63EvA?comment_on=1&comment_root_id=317539013137...#reply317539013137
```

- `BV` 后是 `bvid`，`#reply` 后是 `rpid`；
- 链接里同时有 `comment_root_id` 与 `comment_secondary_id` → **楼中楼**（root 是别人，secondary 是我们）；
- `comment_root_id` 等于 `#reply` 后面那个 rpid 且没有 secondary → **顶层评论**（2026-10-19 23:29 就这么发错过一次）；
- 只有视频链接时，用作者 mid + 评论文本在最新评论里匹配。
