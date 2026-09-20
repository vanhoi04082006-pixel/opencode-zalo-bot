# Remove Windows autostart for serve + tele bot + zalo bridge.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/uninstall-autostart.ps1
$ErrorActionPreference = "SilentlyContinue"

$taskName = "ZaloBridgeAutostart"
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
if ($?) { Write-Host "Removed task '$taskName'." }
else { Write-Host "Task '$taskName' not found (nothing to remove)." }
