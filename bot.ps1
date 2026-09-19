# Zalo bridge console manager (tele-style bot.ps1).
# Usage: .\bot.ps1 [start|stop|restart|status|logs]   (no args = menu)
$ErrorActionPreference = "SilentlyContinue"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $root "bridge.pid"
$logFile = Join-Path $root "bridge-dual.log"

function Get-BridgePid {
  if (!(Test-Path $pidFile)) { return $null }
  $p = [int](Get-Content $pidFile)
  if (Get-Process -Id $p -ErrorAction SilentlyContinue) { return $p }
  return $null
}

function Get-ServeHealth {
  try {
    $h = Invoke-RestMethod -Uri "http://127.0.0.1:4096/global/health" -TimeoutSec 5
    if ($h.healthy) { return "RUNNING" }
  } catch {}
  return "DOWN"
}

function Show-Status {
  $pid = Get-BridgePid
  $serve = Get-ServeHealth
  Write-Host "=== Zalo bridge status ===" -ForegroundColor Cyan
  if ($pid) { Write-Host "Bot      : RUNNING (PID $pid)" -ForegroundColor Green }
  else { Write-Host "Bot      : stopped" -ForegroundColor Yellow }
  if ($serve -eq "RUNNING") { Write-Host "Serve    : RUNNING (port 4096)" -ForegroundColor Green }
  else { Write-Host "Serve    : DOWN" -ForegroundColor Red }
  try {
    $st = Get-Content (Join-Path $root ".bridge-store.json") -Raw | ConvertFrom-Json
    $pg = @($st.projectGroups.PSObject.Properties).Count
    Write-Host "Sessions : $(@($st.sessions.PSObject.Properties).Count) | Groups: $pg | Tasks: $(@($st.tasks).Count)"
  } catch {}
  Write-Host "Log      : $logFile"
  Write-Host "--- last 5 lines ---"
  if (Test-Path $logFile) { Get-Content $logFile | Select-Object -Last 5 | ForEach-Object { Write-Host $_ } }
}

function Start-Bridge {
  if (Get-BridgePid) { Write-Host "Bridge is already running." -ForegroundColor Yellow; return }
  $p = Start-Process -FilePath "node" -ArgumentList "src/bridge.js" -WorkingDirectory $root -RedirectStandardOutput "bridge-dual.log" -RedirectStandardError "bridge-dual.err.log" -WindowStyle Hidden -PassThru
  Write-Host "Bridge starting (PID $($p.Id))..."
  Start-Sleep -Seconds 8
  Show-Status
}

function Stop-Bridge {
  $pid = Get-BridgePid
  if (!$pid) {
    $stale = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*zalo-opencode-bridge*src/bridge.js*" }
    foreach ($s in $stale) { Stop-Process -Id $s.ProcessId -Force; Write-Host "Stopped orphan $($s.ProcessId)" }
    if (!$stale) { Write-Host "Bridge is not running." -ForegroundColor Yellow }
    return
  }
  Stop-Process -Id $pid -Force
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    if (-not (Get-Process -Id $pid -ErrorAction SilentlyContinue)) { break }
  }
  Write-Host "Bridge stopped."
}

function Show-Logs {
  if (Test-Path $logFile) { Get-Content $logFile -Tail 30 -Wait }
  else { Write-Host "No log file yet." -ForegroundColor Yellow }
}

$cmd = $args[0]
if (!$cmd) {
  Write-Host "Zalo Bridge" -ForegroundColor Cyan
  Write-Host "  1) start"
  Write-Host "  2) stop"
  Write-Host "  3) restart"
  Write-Host "  4) status"
  Write-Host "  5) logs"
  Write-Host "  0) exit"
  $cmd = Read-Host "Choose"
  switch ($cmd) { "1" { $cmd = "start" } "2" { $cmd = "stop" } "3" { $cmd = "restart" } "4" { $cmd = "status" } "5" { $cmd = "logs" } default { exit } }
}

switch ($cmd.ToLower()) {
  "start" { Start-Bridge }
  "stop" { Stop-Bridge }
  "restart" { Stop-Bridge; Start-Sleep -Seconds 2; Start-Bridge }
  "status" { Show-Status }
  "logs" { Show-Logs }
  default { Write-Host "Usage: .\bot.ps1 [start|stop|restart|status|logs]" }
}
