# Restart the Zalo bridge cleanly: stop the old instance, wait for real death,
# then start a new one. Always use this instead of kill+start by hand
# (a live old instance sharing the store/socket caused the 11:40 incident).
$ErrorActionPreference = "SilentlyContinue"
$root = "E:\Projects\zalo-opencode-bridge"
$pidFile = Join-Path $root "bridge.pid"

if (Test-Path $pidFile) {
  $old = [int](Get-Content $pidFile)
  Stop-Process -Id $old -Force
  $dead = $false
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    if (-not (Get-Process -Id $old -ErrorAction SilentlyContinue)) { $dead = $true; break }
  }
  if (-not $dead) { Write-Output "OLD STILL ALIVE ($old), aborting."; exit 1 }
  Write-Output "OLD-KILLED ($old)"
} else {
  # No pid file: kill by command line as fallback (only this project's bridge.js).
  $stale = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*zalo-opencode-bridge*src/bridge.js*" }
  foreach ($p in $stale) {
    Stop-Process -Id $p.ProcessId -Force
    Write-Output "OLD-KILLED (fallback $($p.ProcessId))"
  }
  Start-Sleep -Seconds 2
  Write-Output "NO-PID-FILE (fresh start)"
}
# Sweep orphans in ALL cases: pre-guard bridges never wrote bridge.pid,
# so the pid file alone cannot see them. Kill any node running this
# project's bridge.js (except this script's own powershell, which is not node).
$sib = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*zalo-opencode-bridge*src/bridge.js*" }
foreach ($p in $sib) {
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  Write-Output "ORPHAN-KILLED ($($p.ProcessId))"
  Start-Sleep -Seconds 1
}

$p = Start-Process -FilePath "node" -ArgumentList "src/bridge.js" -WorkingDirectory $root -RedirectStandardOutput "bridge-dual.log" -RedirectStandardError "bridge-dual.err.log" -WindowStyle Hidden -PassThru
Write-Output "NEW-PID=$($p.Id)"
Start-Sleep -Seconds 10
Get-Content (Join-Path $root "bridge-dual.log") | Select-Object -Last 8
