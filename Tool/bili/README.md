# Tool\bili —— 工具层入口（精简版）

> 完整手册：**`Tool\Tool.md`** ｜ 改动理由与代价：**`Tool\DECISIONS.md`** ｜ 接口实测与踩坑：**`API-NOTES.md`**
>
> **判定口径只有一条**：`History\ledger.json` 的 `verdict` / `sum_like` / `gap`（由 `ledger.mjs` 产出）。
> `History\state.json` 是"内容获赞"监控，**不参与判定**——B 站主页获赞不含评论获赞（见 `Tool.md §4.0`）。

## 三条命令

```powershell
node Tool\bili\ledger.mjs report     # 判定：本周评论累计获赞 / gap / 未定位评论
node Tool\bili\ledger.mjs sync --pages 10   # 回查每条评论的赞数
node Tool\bili\sensor.mjs --print    # 监控内容获赞（异常上涨才需关注）
node Tool\bili\audit.mjs             # 审计判定数据（21 项，退出码 1 = 不可信）
```

## 脚本清单

| 脚本 | 职责 |
|---|---|
| `ledger.mjs` | **判定权威**：`add` / `sync` / `set` / `label` / `report` / `list` |
| `sensor.mjs` | 采集账号"内容获赞"（监控用），零依赖，Node ≥ 18 |
| `hunt.mjs` | 猎候选视频：热区 / `--cold` 冷启动 / `--niche` 小播放 |
| `hotthread.mjs` | 找楼中楼目标：楼内回复战绩 + 根评论增速（v3，`--golden` 只看爆炸楼） |
| `proven.mjs` | 把 `Tool\inbox\proven-links.md` 里的已获赞评论收进资产库 |
| `audit.mjs` | 校验判定数据由脚本产出且自洽（只读） |
| `config.json` | mid / 目标 / 时间窗 / 采样与猎手参数（`metric` 是监控指标，`judge_metric` 是判定口径） |

## 常见坑（细节见 `API-NOTES.md`）

- 只能 Node `fetch` 打 B 站，PowerShell `Invoke-WebRequest` 会 TLS 失败；
- `Get-Content` 读 `History\*.json` 会按 ANSI 解码乱码 → 用 `-Encoding UTF8` 或 `node -e`；
- 评论发出后 **1 小时内** `add` + `sync`，否则沉底只能手工 `set`；
- 对同一 rpid 重复 `add` 会**重置**赞数历史；补标签用 `label`。
