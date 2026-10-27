# archive —— 目标结算归档

> 索引见 `Tool\Tool.md`。本文件讲归档怎么做、为什么这样做。

## 职责

感知器返回 **PASS** 或 **FAILED** 后，把当前目标整体结算入 `Archived\`，并把根目录恢复成可开新目标的骨架。对应 `AGENTS.md` 全局规则 3。

## 用法

```powershell
pwsh -File Tool\archive\archive.ps1 -Description "B站小号生存圈子发现"
pwsh -File Tool\archive\archive.ps1        # 不给描述则用 Tool\bili\config.json 的 goal 字段
```

## 行为

| 步骤 | 动作 |
|---|---|
| 1 | 建 `Archived\goal<目标开始时间>_<最简描述>\`（已存在则**拒绝覆盖**） |
| 2 | 搬入 `Goal\`、`History\`、`Tool\`（除 `git`、`archive`） |
| 3 | 复制根 `AGENTS.md` 进归档目录（连同当时的规则） |
| 4 | 写 `archived.md`：目标原文、判定、留痕索引、**口径偏差记录** |
| 5 | 根重建空 `Goal\` 目录 + 空白 `Tool\Tool.md` 骨架 |

## 硬约束

- **不写 `Goal\Goal.md`**：该文件仅用户可写。归档后 `Goal\` 只剩空目录，新目标由用户写。
- **不删改 `History\`**：判定数据事后不可变，原样搬走。
- **不自动 commit/push**：推送须人工确认（见 `Tool\git\git.md`）。
- **不归档** `Skills\`、`Tool\git\`、`Tool\archive\`：跨目标复用。
- **必须记录口径偏差**：若实际执行口径与 `Goal.md` 字面不一致，`archived.md` 里必须写清"按 Goal.md 字面结论会是什么"。这是防止"改口径凑 PASS"的唯一机制。

## 已知边界

- 归档后 `History\` 不存在，下一轮 `collect.mjs` 会自己重建目录（`ensureDir`）。
- 目标开始时间取自 `Tool\bili\config.json` 的 `window.start`；该工具若已被别的目标替换，脚本会退化为用当前时间。
