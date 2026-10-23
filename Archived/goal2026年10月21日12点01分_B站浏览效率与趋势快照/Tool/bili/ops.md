# ops.md —— 运维层（budget / pace / wait / finalize / probe_risk）

> 一句话：管额度、管节拍、管收尾、测风控。这些工具不产出数据，只保证"任务能跑完"。
> 索引见 [../Tool.md](../Tool.md)。

## budget.mjs —— 额度对账

```powershell
node Tool\bili\budget.mjs          # 人读
node Tool\bili\budget.mjs --json   # 机器读（audit 内部直接用这个函数，不走子进程）
```

读本机 DSH cost-meter 真实账目（`%DSH_HOME%\storages\cost-meter\ledger.json`），按当前 `DSH_SESSION_ID` 汇总 calls / token / 花费。

**为什么不用子进程**：沙箱禁止管道捕获（`stdio: 'pipe'` 会 EPERM），所以 `budget.mjs` 同时导出 `budgetReport()` 供 `audit.mjs` 直接 import。

### 实测价格基准（deepseek-flash，谷时）
输入未命中 $0.15/M、命中 $0.003/M、输出 $0.6/M；峰时翻倍；汇率 7.2。
**单次调用实测 ≈ ¥0.0111**，这是把人民币预算换算成调用数的依据。

### 峰时窗口
北京时间 **09:00–12:00 与 14:00–18:00** 是 2 倍价。官方时段之所以选 08:00/13:00/20:00，就是为了避开峰时。

## pace.mjs —— 轮次节拍器

```powershell
node Tool\bili\pace.mjs --kind light --cap-min 9.5 --min-wait-min 9.3
```

**解决的问题**：DSH 自治轮次是**即时续轮**，不会自己等。不节拍的话 40 轮会在几分钟内烧完。

**机制**：轮询 `samples.ndjson`，等到出现新样本（或到了 cap）才交还控制权；退出时一次性打印期间所有新样本、新事件、`latest.md`、官方快照进度，并**自动往 `l2_rounds.ndjson` 追加一条轮次记录**（"每轮覆盖了全部新样本"的机器证据）。

### 节拍参数怎么来的
- **执行器单次命令硬上限 10 分钟**（实测被砍在 600,000ms）→ `--cap-min` 不得超过 9.5
- 等待 `min-wait-min` 必须 ≥ 采样周期（light 8 分钟），否则会出现"空放一轮"
- 覆盖时长 ≈ 轮次 × 9.5 分钟。要覆盖 46 小时需约 290 轮，**这也是轮次预算的算法**

### 教训
一次把两个 9.3 分钟的等待串在同一条命令里，总时长 18.6 分钟 → 被砍在第 10 分钟。**一条命令只放一次等待。**

## wait.mjs —— 简易等待

`node Tool\bili\wait.mjs --cap-min 11`：只等新样本，不打印摘要、不写轮次记录。`pace.mjs` 的早期版本，仍可用于临时探查。

## finalize.mjs —— 一键收尾

```powershell
node Tool\bili\finalize.mjs
```

做三件事：刷新 `trend_log.md` → 刷新 `trend_report.md` → 跑 `audit.mjs` 并落 `verdict.json`，末尾打印判定摘要。

**设计意图：收尾可被任何人、任何时刻重放**，不依赖任何记忆或对话上下文。48 小时任务里 LLM 不能保证届时在线，所以这条命令是必需项，不是方便项。

子进程用 `stdio: 'inherit'`（沙箱允许，`pipe` 不允许）。

### 它真的被自动调用过
`collect.mjs` 的 `maybeFinalize()` 在 2026-10-23 08:10:18（全部时点结算后）自动执行了它，并写 `History/DONE.flag`。**这是本项目最满意的设计：完工不依赖 LLM 在场。**

## probe_risk.mjs —— 风控探针

```powershell
node Tool\bili\probe_risk.mjs
```

递增频率（5s×6 → 3s×6 → 1s×10）打同一接口，记录每次的 `code` 与耗时；触发非 0 code 立即停止该阶段，并测恢复时间。结果写 `History/probe_risk.json`。

**产出**：安全间隔、触发点、恢复时长。

### 它给出的结论（以及一处需注意的局限）
同端点 1 秒间隔连打 10 次全部 200 → 说明**速率不是主因**。
但仅凭这个探针会得出"限制按端点多样性判定"的错误结论——真正的原因是请求指纹（见 [collect.md](collect.md) §请求头）。
**教训：探针只能证伪速率假设，不能证明机制；机制要靠受控变量对照（换 UA/Referer/Cookie 各一次）。**

## 运维常用组合

```powershell
# 检查是否健康
node Tool\bili\audit.mjs; node Tool\bili\budget.mjs; Get-Content History\latest.md -Encoding UTF8

# 采集器挂了（必须用受管后台 job，不能用 Start-Process）
node Tool\bili\collect.mjs --serve

# 窗口结束
node Tool\bili\finalize.mjs; Get-Content History\DONE.flag -Encoding UTF8
```
