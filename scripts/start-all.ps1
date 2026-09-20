# Ordered autostart chain: opencode serve -> telegram bot -> zalo bridge.
# Each step waits for health before the next. Safe to re-run (skips live parts).
# Called by Task Scheduler at logon (see install-autostart.ps1) or by hand:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-all.ps1
$ErrorActionPreference = "SilentlyContinue"

$zaloRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$teleRoot = "E:\Projects\opencode-telegram-bot"
$servePort = "4096"
$healthUrl = "http://localhost:$servePort/global/health"
$logFile = Join-Path $zaloRoot "logs\start-all.log"

function Log($msg) {
  $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
  Write-Host $line
  try { Add-Content -LiteralPath $logFile -Value $line -Encoding utf8 } catch {}
}

function Get-ServeHealth {
  try {
    $r = curl.exe -s -m 5 $healthUrl 2>$null
    if ($r -match '"healthy":true') { return $true }
  } catch {}
  return $false
}

function Wait-Healthy($label, $seconds) {
  for ($i = 0; $i -lt $seconds; $i++) {
    if (Get-ServeHealth) { return $true }
    Start-Sleep -Seconds 1
  }
  Log "$label NOT healthy after ${seconds}s"
  return $false
}

function Get-Proc($matchers) {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $c = $_.CommandLine
      foreach ($m in $matchers) { if ($c -like $m) { return $true } }
      $false
    }
}

Log "=== autostart chain begin ==="

# 1. Serve first (shared by both bots).
$serve = Get-CimInstance Win32_Process -Filter "Name='opencode.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*serve*" -and $_.CommandLine -like "*$servePort*" }
if ($serve) {
  Log "serve already running (PID $($serve.ProcessId))"
} else {
  $opencodeExe = (Get-Command "opencode.exe" -ErrorAction SilentlyContinue).Source
  if (-not $opencodeExe) { $opencodeExe = Join-Path $env:APPDATA "npm\node_modules\opencode-ai\bin\opencode.exe" }
  if (!(Test-Path -LiteralPath $opencodeExe)) { Log "FATAL: opencode.exe not found"; exit 1 }
  Log "starting serve..."
  Start-Process -FilePath $opencodeExe -ArgumentList "serve", "--port", $servePort -WorkingDirectory "E:\" -WindowStyle Hidden
}
if (-not (Wait-Healthy "serve" 60)) { exit 1 }
Log "serve healthy"

# 2. Telegram bot (own repo script, hidden).
$teleBot = Get-Proc @("*opencode-telegram-bot*dist/index.js*", "*opencode-telegram-bot*dist\index.js*")
if ($teleBot) {
  Log "tele bot already running (PID $($teleBot.ProcessId))"
} else {
  $telePs1 = Join-Path $teleRoot "bot.ps1"
  if (Test-Path -LiteralPath $telePs1) {
    Log "starting tele bot..."
    powershell -NoProfile -ExecutionPolicy Bypass -File $telePs1 start | ForEach-Object { Log "[tele] $_" }
  } else {
    Log "tele bot.ps1 missing at $telePs1, skipped"
  }
}

# 3. Zalo bridge (own repo script, hidden).
$zaloPs1 = Join-Path $zaloRoot "bot.ps1"
Log "starting zalo bridge..."
powershell -NoProfile -ExecutionPolicy Bypass -File $zaloPs1 start | ForEach-Object { Log "[zalo] $_" }

Log "=== autostart chain done ==="
