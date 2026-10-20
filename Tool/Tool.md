# Tool.md —— 执行器契约 / 冷启动手册

> 本文件是"世界"的工具层入口。**新建对话或清理上下文后，先读这一页，再读 `Goal\Goal.md`，然后跑一次感知器**，不要相信本文末尾的状态快照。
>
> 对应 `AGENTS.md` 的 LOOP：`感知差距[Sensor] → 规划 → 执行[Tool] → 重新感知`，终止条件 `verdict = PASS`。
>
> **要改工具，先读 `Tool\DECISIONS.md`**（为什么这样设计、代价、回滚方式），改完必须在里面补一条。
>
> **B站工具详细用法**见 `Tool\bili\bili.md`。
>
> ⚠ 会**越过工作目录边界**的动作（目前只有 `Tool\git\push.ps1`）**必须先取得人工授权**，见 **§4**。

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

## 2. 工具地图

| 目录/文件 | 职责 |
|---|---|
| `Tool\bili\` | B站相关工具（详细用法见 `bili.md`） |
| `Tool\bili\config.json` | mid / 目标 / 时间窗 / 采样参数 |
| `Tool\git\` | Git 操作（详细规则见 `git\git.md`） |
| `Tool\inbox\drafts.md` | 草稿唯一真源 |
| `Tool\DECISIONS.md` | 改工具必须先在此留一条 |

---

## 3. 文件地图

| 文件 | 谁写 | 可否手改 |
|---|---|---|
| `Goal\Goal.md` | **仅用户** | LLM 只读，禁止写入 |
| `History\state.json` | sensor | 否（监控快照，**不参与判定**） |
| `History\history.ndjson` | sensor 追加 | 否（审计留痕） |
| `History\comments.ndjson` | ledger 追加 | 否（事件日志，只增） |
| `History\ledger.json` | ledger 重写 | 否 |
| `History\candidates_*.json` | hunt | 否（派生，可重跑） |
| `History\hotthreads.json` | hotthread | 否（派生，可重跑） |
| `History\hotthread_history.ndjson` | hotthread 追加 | 否（根评论赞数快照，用于算增速） |
| `History\sensor_error.json` | sensor（仅配置错误时） | 是 |
| `Tool\inbox\drafts.md` | 人 / LLM | **是（草稿唯一真源）** |
| `Tool\bili\config.json` | 人 | 是 |
| `Tool\DECISIONS.md` | 人 / LLM | 是（改工具必须先在此留一条） |

**根目录只允许三个目录：`Goal\`（用户的目标，只读）、`Tool\`（工具与配置）、`History\`（全部机器生成的产物）。** 新增产物一律放进这三棵子树。

---

## 4. 必须人工授权的工具

> 这一节与 `AGENTS.md §2`（"只能通过 `Tool\` 下的脚本改变世界"）是**叠加**关系：
> **能被脚本做到 ≠ 可以自动做**。下列工具在无人确认时**一律不执行**。
>
> 提出：2026-10-19 23:50，用户要求（见 `DECISIONS.md` D14）。

### 授权流程（三步，缺一不可）

1. **说明**——执行前用一句话讲清：目的、影响范围（本地/远端/账号）、能否回滚；
2. **取得明确同意**——等用户在**当前对话**里明确回答（"推吧" / "可以" / "执行"）。
   沉默、只问问题、模糊表述（"看着办"）**都不算授权**，此时不执行；
3. **留痕**——执行后在回复里报告：成功/失败、远端分支与 commit 号、影响范围。

### 授权粒度

默认**一事一授权**（一次执行 = 一次同意）。只有用户明确说"以后都行 / 本会话内都可"才放宽；即便放宽，每次执行仍必须报告结果。授权**不可跨会话继承**。

### 清单

| 工具 | 副作用 | 为什么必须授权 | 授权粒度 |
|---|---|---|---|
| `Tool\git\push.ps1` | 把本地提交推送到 GitHub `origin/main` | ① **远端可见且不可撤回**；② 使用真人的账号凭据；③ 是唯一会越过工作目录边界的动作 | 每次推送；重试不算重新授权，但更换远端/分支/强推必须重新授权 |

### 不在本清单里的（默认无需授权）

- 只读或本地派生：`sensor.mjs`、`ledger.mjs`（`report`/`list`/`sync`）、`audit.mjs`、`hunt.mjs`、`hotthread.mjs`、`proven.mjs` —— 它们只读 B 站公开接口、只写 `History\` 下的文件，删掉可重跑；
- **发评论**仍然只能人工，它压根不在脚本层，所以不进本清单。

---

## 5. 红线

不做、也不写进任何工具：多账号、互赞群、刷赞、脚本模拟点击、盗用他人 cookie。
赞必须来自真实用户对真实评论的自发认可。
