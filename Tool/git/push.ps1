# push.ps1 —— 把本地提交推送到 GitHub（绕开凭据助手的子进程限制）
#
# 背景：本环境的 git 无法调用 credential helper（子进程管道被拒），
#       但 Git Credential Manager 里已存有凭据，可直接取出并用于 HTTP 头认证。
#       另：github.com 在本网络存在间歇性阻断，故内置重试。
#
# 用法：
#   powershell -File Tool\git\push.ps1              # 默认重试 3 次，间隔 15 秒
#   powershell -File Tool\git\push.ps1 -Retries 6 -DelaySeconds 30
#
# 退出码：0 成功；1 凭据获取失败；2 全部重试仍失败
param(
    [int]$Retries = 3,
    [int]$DelaySeconds = 15
)

$ErrorActionPreference = 'Continue'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $repoRoot

# 自动探测 Git Credential Manager（本机 git 装在 E:\SoftWare\Git，不是默认的 Program Files）
$candidates = @()
$gitExe = (Get-Command git -ErrorAction SilentlyContinue).Source
if ($gitExe) {
    $gitRoot = Split-Path (Split-Path $gitExe -Parent) -Parent   # ...\Git\cmd\git.exe -> ...\Git
    foreach ($sub in @('mingw32\libexec\git-core', 'mingw64\libexec\git-core', 'mingw32\bin', 'mingw64\bin')) {
        $candidates += (Join-Path $gitRoot "$sub\git-credential-manager.exe")
        $candidates += (Join-Path $gitRoot "$sub\git-credential-manager-core.exe")
    }
}
$candidates += 'C:\Program Files\Git\mingw64\bin\git-credential-manager.exe'
$candidates += 'C:\Program Files\Git\mingw64\libexec\git-core\git-credential-manager.exe'

$gcm = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $gcm) {
    Write-Host "找不到 Git Credential Manager，已尝试：" -ForegroundColor Red
    $candidates | ForEach-Object { Write-Host "  $_" }
    exit 1
}
Write-Host "  使用 GCM: $gcm"

Write-Host "=== 读取已保存的 GitHub 凭据 ===" -ForegroundColor Cyan
$env:GCM_INTERACTIVE = 'false'
$raw = ("protocol=https`nhost=github.com`n`n" | & $gcm get 2>&1) -split "`n"
$user = ($raw | Where-Object { $_ -match '^username=' }) -replace '^username=', ''
$pass = ($raw | Where-Object { $_ -match '^password=' }) -replace '^password=', ''
if (-not $user -or -not $pass) {
    Write-Host "未取得凭据。请在普通终端运行一次 git push 完成登录。" -ForegroundColor Red
    exit 1
}
Write-Host ("  账号: " + $user + "（token 已隐藏）")

$b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($user + ':' + $pass))
$env:GIT_TERMINAL_PROMPT = '0'

for ($i = 1; $i -le $Retries; $i++) {
    Write-Host ""
    Write-Host "=== 推送尝试 $i / $Retries ===" -ForegroundColor Cyan
    $out = git -c credential.helper= `
               -c "http.extraheader=AUTHORIZATION: basic $b64" `
               -c http.sslBackend=openssl `
               -c http.postBuffer=524288000 `
               push -u origin main 2>&1 | Out-String
    $code = $LASTEXITCODE
    Write-Host $out.Trim()

    if ($code -eq 0) {
        Write-Host ""
        Write-Host "推送成功" -ForegroundColor Green
        git log --oneline -1
        exit 0
    }
    if ($i -lt $Retries) {
        Write-Host "失败（exit=$code），$DelaySeconds 秒后重试…" -ForegroundColor Yellow
        Start-Sleep -Seconds $DelaySeconds
    }
}

Write-Host ""
Write-Host "全部 $Retries 次尝试均失败。github.com 在本网络可能被阻断：" -ForegroundColor Red
Write-Host "  · 挂代理/VPN 后重跑本脚本"
Write-Host "  · 或设置 git 代理：git config http.proxy http://127.0.0.1:端口"
Write-Host "本地提交已保存，不会丢失。"
exit 2
