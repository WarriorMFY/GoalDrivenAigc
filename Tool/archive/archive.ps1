# archive.ps1 —— 目标结算归档（AGENTS.md 全局规则 3）
#
# 用法：
#   pwsh -File Tool\archive\archive.ps1 -Description "B站小号生存圈子发现"
#   pwsh -File Tool\archive\archive.ps1            # 用 config.json 里的 goal 字段推断描述
#
# 做什么：
#   1. 把 Goal\、History\、Tool\（除 git / archive）整体移入
#      Archived\goal<目标开始时间>_<最简描述>\
#   2. 把根 AGENTS.md 复制一份进归档目录（连同当时的规则）
#   3. 写 archived.md（目标原文 + 判定 + 结论 + 口径偏差 + 留痕指引）
#   4. 在根重建空白 Tool\Tool.md 骨架，并重建空 Goal\ 目录
#
# 不做什么：
#   - 不写 Goal\Goal.md（仅用户可写）；归档后 Goal\ 只剩空目录，等用户写新目标
#   - 不删改 History\（原样搬走，判定数据事后不可变）
#   - 不 git commit / push（推送须人工确认，见 Tool\git\git.md）
#   - 不归档 Skills\、Tool\git\、Tool\archive\（跨目标复用）

param(
    [string]$Description = ""
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $root
Write-Host "仓库根：$root"

# ---- 读取目标信息 ----
$cfgPath = Join-Path $root 'Tool\bili\config.json'
$goalText = ''
$goalMdRoot = Join-Path $root 'Goal\Goal.md'
if (Test-Path $goalMdRoot) {
    $goalText = Get-Content -Raw -Encoding UTF8 $goalMdRoot
}
$goalLine = ($goalText -split "`n" | Where-Object { $_.Trim() -ne '' -and -not $_.StartsWith('#') } | Select-Object -First 1)
if (-not $goalLine) { $goalLine = '' }
$goalLine = $goalLine.Trim()

$startIso = $null
if (Test-Path $cfgPath) {
    $cfg = Get-Content -Raw -Encoding UTF8 $cfgPath | ConvertFrom-Json
    $startIso = $cfg.window.start
    if (-not $Description -and $cfg.goal) { $Description = $cfg.goal }
}
if (-not $Description) { $Description = '未命名目标' }
$Description = $Description -replace '[\\/:*?"<>|]', ''
# 描述过长会让目录名难读，压到 24 字以内
if ($Description.Length -gt 24) { $Description = $Description.Substring(0, 24) }

if ($startIso) {
    $dto = [datetimeoffset]::Parse($startIso).LocalDateTime
} else {
    $dto = Get-Date
}
$stamp = '{0}年{1}月{2}日{3}点{4}分' -f $dto.Year, $dto.Month, $dto.Day, $dto.Hour, $dto.Minute
$target = Join-Path $root ("Archived\goal$stamp" + "_$Description")
if (Test-Path $target) {
    Write-Host "归档目录已存在，按续跑处理（只搬剩余项，不覆盖已有文件）：$target" -ForegroundColor Yellow
}
New-Item -ItemType Directory -Force -Path $target | Out-Null
# Tool 子目录必须先建，否则 Move-Item 到 Tool\<name> 会因父目录缺失而失败
New-Item -ItemType Directory -Force -Path (Join-Path $target 'Tool') | Out-Null
Write-Host "归档到：$target"

# 续跑兜底：根 Goal.md 已被搬走时，从归档目录里补读目标原文（否则 archived.md 会写成"无目标行"）
if (-not $goalLine -and (Test-Path (Join-Path $target 'Goal\Goal.md'))) {
    $goalText = Get-Content -Raw -Encoding UTF8 (Join-Path $target 'Goal\Goal.md')
    $goalLine = ($goalText -split "`n" | Where-Object { $_.Trim() -ne '' -and -not $_.StartsWith('#') } | Select-Object -First 1)
}
if (-not $goalLine) { $goalLine = '（Goal.md 无目标行）' }
$goalLine = $goalLine.Trim()

# ---- 搬运 ----
$moved = @()
foreach ($d in @('Goal', 'History')) {
    $src = Join-Path $root $d
    if (Test-Path $src) {
        Move-Item -LiteralPath $src -Destination (Join-Path $target $d)
        $moved += "$d\"
    }
}

$keepTools = @('git', 'archive')
$toolSrc = Join-Path $root 'Tool'
if (Test-Path $toolSrc) {
    Get-ChildItem -LiteralPath $toolSrc -Directory | Where-Object { $keepTools -notcontains $_.Name } | ForEach-Object {
        Move-Item -LiteralPath $_.FullName -Destination (Join-Path $target ('Tool\' + $_.Name))
        $moved += "Tool\$($_.Name)\"
    }
    $toolMd = Join-Path $toolSrc 'Tool.md'
    if (Test-Path $toolMd) {
        New-Item -ItemType Directory -Force -Path (Join-Path $target 'Tool') | Out-Null
        Move-Item -LiteralPath $toolMd -Destination (Join-Path $target 'Tool\Tool.md')
        $moved += 'Tool\Tool.md'
    }
}

Copy-Item -LiteralPath (Join-Path $root 'AGENTS.md') -Destination (Join-Path $target 'AGENTS.md') -Force
Write-Host ("已搬运：" + ($moved -join '、'))

# ---- 归档说明 ----
$verdictPath = Join-Path $target 'History\verdict.json'
$verdictLine = '（无 verdict.json）'
if (Test-Path $verdictPath) {
    $v = Get-Content -Raw -Encoding UTF8 $verdictPath | ConvertFrom-Json
    $verdictLine = "**$($v.overall)**（样本 $($v.stamp)，剩余窗口 $($v.window.remainingHours)h）"
}

$archivedMd = @"
# 归档：$Description

- **归档时间**：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
- **目标开始**：$stamp
- **目标原文**：$goalLine
- **结束判定**：$verdictLine

## 本目标留下的东西

| 位置 | 内容 |
|---|---|
| ``Goal\Goal.md`` | 目标与判据原文（用户所写，未改动） |
| ``History\samples\`` | 每轮取样明细（判定数据源，含 sha256） |
| ``History\audits\`` | 每轮自检（粉丝直方图、口径标签、索引一致性） |
| ``History\verdicts.ndjson`` | 判定历史（只追加，不删改） |
| ``History\reports\`` | 排行榜与最终交付 |
| ``History\pooled.json`` | 跨轮合并（稳健性参考，非判据） |
| ``Tool\bili\`` | 本目标专用工具（collect / sensor / audit / pool / probe） |
| ``AGENTS.md`` | 归档当时的全局规则副本 |

## 口径偏差记录（必须保留）

``Goal\Goal.md`` 与实际执行之间存在两处偏差，均由用户在 2026-10-26 的 desc-to-spec 盘问中定稿，但 **Goal.md 未同步改写**（该文件仅用户可写）：

1. 小号口径：Goal.md 写 ``fans = 0``；实际执行 ``fans ≤ 100 且 投稿数 ≤ 20``。
   原因：实测 40 条 pubdate 样本中 0 粉号作品为 0 条 —— B 站搜索不收录 0 粉号作品，原口径**不可观测**。
2. 每词样本量：Goal.md 写 50 条；实际执行 60 条（3 页 × 20）。

**若严格按 Goal.md 字面（fans = 0）判定，三轮均为 INSUFFICIENT，结论应为 FAILED，而非 PASS。**
本目标的 PASS 是"按用户定稿口径"的结论。

## 未归档（跨目标复用）

``Skills\``、``Tool\git\``、``Tool\archive\``。
"@

$archivedPath = Join-Path $target 'archived.md'
[System.IO.File]::WriteAllText($archivedPath, $archivedMd, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "已写：$archivedPath"

# ---- 根目录重建骨架 ----
New-Item -ItemType Directory -Force -Path (Join-Path $root 'Goal') | Out-Null
$toolMdNew = @"
# Tool\ —— 工具索引
> 本文件只做索引：每个工具一行职责与适用场景，实践细节放在同名 ``.md`` 中。

## 状态

空，随新目标重建（``git``、``archive`` 为跨目标复用工具，保留）。

## 约定

- 根级只留本文件；
- 每个工具一个子目录，里面一篇同名 ``.md``（渐进披露：索引保持精简）。

## 工具清单

| 工具 | 职责 | 何时用 | 详情 |
|---|---|---|---|
| ``git`` | 提交与推送（含凭据提取、断网重试） | 需要把本地改动同步到远端时；push 须先经用户确认 | ``Tool\git\git.md`` |
| ``archive`` | 目标结算归档、重建根骨架 | 感知器返回 PASS/FAILED 后 | ``Tool\archive\archive.md`` |
"@
[System.IO.File]::WriteAllText((Join-Path $root 'Tool\Tool.md'), $toolMdNew, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "已重建：Tool\Tool.md"

Write-Host ""
Write-Host "归档完成。根目录现状：" -ForegroundColor Green
Get-ChildItem -LiteralPath $root -Force | Select-Object Mode, Name | Format-Table -AutoSize | Out-String | Write-Host
Write-Host "注意：Goal\ 现在是空目录，新目标由用户写 Goal\Goal.md。"
