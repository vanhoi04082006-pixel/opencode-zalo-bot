# Register Windows autostart for serve + tele bot + zalo bridge.
# No admin needed (current-user logon trigger). Idempotent: re-run safely.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-autostart.ps1
$ErrorActionPreference = "Stop"

$taskName = "ZaloBridgeAutostart"
$script = Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) "scripts\start-all.ps1"

try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
$trigger.Delay = "PT1M"  # 60s for network
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Description "Autostart opencode serve + telegram bot + zalo bridge at logon" | Out-Null

Write-Host "Installed task '$taskName' (logon + 60s delay, restart-on-fail x3)."
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
