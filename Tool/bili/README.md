# Tool\bili\ —— 感知器（获赞）

LOOP 的第一步：把"目标差距"变成可判定的数字。规划器只读 `History\state.json`，不凭感觉。

## 文件

| 文件 | 作用 |
|---|---|
| `sensor.mjs` | 采集器。零依赖，只需 Node ≥ 18（本机 v24） |
| `config.json` | 配置：`mid`、`target`、时间窗、采样参数 |
| `History\state.json` | 生成的快照（最新一次感知结果） |
| `History\history.ndjson` | 生成的追加式时间序列，一行一次采样 |

## 快速开始

```powershell
# 1. 在 config.json 填 "mid"（B 站数字 ID），或直接带参运行
node Tool\bili\sensor.mjs --mid 1234567 --print

# 2. 以当前值为基准开始计时（正式启动那天跑一次）
node Tool\bili\sensor.mjs --set-baseline --print

# 3. 之后每轮 LOOP 跑一次即可；判定看 History\state.json 的 verdict
node Tool\bili\sensor.mjs

# 试跑不落盘到 Goal/（写到临时目录）
node Tool\bili\sensor.mjs --mid 1234567 --out "$env:TEMP\bili" --print
```

退出码：`0` 采集成功 · `2` 取数失败 · `3` 未配置 mid。

## state.json 契约

```json
{
  "t": "2026-10-19T15:50:00+08:00",
  "ok": true,
  "mid": 1234567,
  "phase": "ACTIVE",              // NOT_STARTED | ACTIVE | CLOSED
  "verdict": "GAP",               // PASS | GAP | NOT_STARTED | FAILED | UNKNOWN
  "reliable": true,               // 采样是否一致，false 表示该指标不可信
  "like_num": 812,                // 本次采样最大值
  "like_num_min": 812,            // 本次采样最小值
  "spread": 0,                    // 极差（缓存抖动幅度）
  "samples": [812, 812, 812],
  "baseline": { "like_num": 762, "at": "…", "initialized": true },
  "delta": 50,                    // like_num - baseline（乐观上界）
  "delta_strict": 50,             // 严格下界：最陈旧缓存也认账的增量
  "target": 50,
  "gap": 0,
  "gap_strict": 0,
  "noise": { "n": 5, "spread": 0, "tolerance": 10, "level": "NONE", "hint": "…" },
  "attribution": { "risk": "CLEAN", "note": "账号无自有内容，总获赞增量可视为评论获赞", "…": "…" },
  "note": "已达目标：严格下界 +50 赞（目标 50）"
}
```

**判定规则**：`verdict === "PASS"` 当且仅当 `delta_strict >= target`。用严格下界而不是最大值，是为了让"达标"这件事不可辩解——哪怕最陈旧的 CDN 缓存也显示够了，才终止 LOOP。

## 已知缺陷与设计取舍（实测，非推测）

1. **`like_num` 有 CDN 缓存抖动。** 实测 `mid=546195` 1 秒内在两簇值间跳变，稳定相差 **194**；随机参数、`photo=false` 都绕不开。
   → 对策：默认连续采样 5 次，取 max 为当前值、min 为严格下界，并输出 `spread` / `reliable`。
2. **抖动只出现在大号上。** 实测 `like_num` 在 0–39 量级的小号上极差恒为 0（扫了 10 个 mid）。
   → 对本目标（0 → 50）该指标**可用**；`reliable=false` 只在异常时出现。
3. **`like_num` 是"账号总获赞"。** 若账号有视频/专栏/动态，增量会混入非评论来源。
   → `attribution.risk` 会读 `navnum` 自动标注 `MIXED`。此时应改用评论级台账（口径 B）。
4. **基准存在 `History\state.json` 里**，不在 `config.json`（后者保持人类可读可手改）。删除 `state.json` 会丢基准，需重跑 `--set-baseline`。
5. **不做的部分**：多账号、互赞、刷赞、模拟点击。这条永不会进 Tool。

## 与 LOOP 的接法

```
每轮：node Tool\bili\sensor.mjs → 读 History\state.json
      verdict=PASS            → 终止
      verdict=GAP             → 按 gap_strict 规划任务
      verdict=UNKNOWN →exit≠0 → 人工升级（人在环）
      reliable=false          → 人工升级：指标不可用，需切口径 B
```

时间序列建议挂 Windows 计划任务每 15 分钟跑一次（纯读，无副作用），避免"被取消的赞"造成数据断层，也便于事后核对真实增量。

---

# `ledger.mjs` —— 评论台账（口径 B 归因层）

`like_num` 只能回答"账号总共涨了多少赞"，回答不了"这 50 个赞是不是本周评论挣的"。台账把每条评论单独记账。

## 用法

```powershell
# 发完评论后立刻登记（rpid 从评论链接 #reply<数字> 里取）
node Tool\bili\ledger.mjs add --bvid BV1xx411c7mD --rpid 123456789 --text "评论内容"

# 回查赞数（默认翻 10 页最新评论）
node Tool\bili\ledger.mjs sync --pages 10

# 页面肉眼看到但脚本没抓到时的兜底
node Tool\bili\ledger.mjs set --rpid 123456789 --like 7

# 汇总：本周评论累计赞 + 与总获赞增量的交叉核对
node Tool\bili\ledger.mjs report
```

## 产物

| 文件 | 说明 |
|---|---|
| `History\comments.ndjson` | 追加式事件日志（`add` / `sync` / `set`），只增不改 |
| `History\ledger.json` | 派生汇总：`sum_like`、`gap`、`unexplained_likes`、逐条明细 |

`report` 会读 `History\state.json` 做交叉核对：

- `unexplained_likes ≈ 0` → 总获赞增长全部来自本周评论，归因干净；
- `unexplained_likes > 0` → 多出来的赞来自旧评论/动态/相册，**不是本周战绩**，需人工确认；
- `unexplained_likes < 0` → 有赞被取消或基线漂移。

## 已知限制（实测）

1. **没有"按 rpid 单查"的公开接口**：`/x/v2/reply/detail` 返回 `-400`。只能从 `reply/main?mode=2`（时间倒序）往前翻页找。
   → 评论发出后 `sync` 越晚，越可能 MISSING。`first_seen_at` 记录了首次定位时刻，可量化这个衰减。
2. **`sort=0`（按时间）老接口已失效**，匿名返回 0 条；`sort=2`（热度）匿名只给 3 条。所以只用 `reply/main`。
3. **匿名翻页有上限**：首页 17 条、后续每页 20 条，`--pages` 控制深度（上限 50）。
4. 分页用 `cursor.next` 整数游标，`pagination_str` 等价，两者无重叠。

---

# `audit.mjs` —— 判定数据审计

AGENTS.md §2 要求"所有用于判定的数据必须由 `Tool\` 下的脚本产出"。这条规则靠自觉是守不住的，所以用脚本检查：

```powershell
node Tool\bili\audit.mjs           # 失败时退出码 1
node Tool\bili\audit.mjs --print   # 打印 18 项逐项结果
```

**只读，不取网络数据，不写任何文件。** 校验四类：

1. **产物存在性** —— 四个 History 文件是否存在且可解析；
2. **快照可信性** —— 字段齐全、`ok=true`、`source` 标记为脚本产出、verdict 合法；
3. **留痕一致性** —— `history.ndjson` 末行与 `state.json` 同源（时间戳、`like_num`、verdict 全等），首行样本等于基准，时间单调；
4. **交叉核对自洽** —— 台账明细可由事件日志重新派生、`sum_like` 一致、`unexplained_likes` 自洽、与感知增量一致、配置未漂移。

实测能抓到的造假：手写 `like_num`、伪造 `PASS`、手改 `sum_like`、删除关键字段。
