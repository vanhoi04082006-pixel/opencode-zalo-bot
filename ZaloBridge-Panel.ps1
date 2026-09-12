# Zalo bridge control panel: everything runs HIDDEN, shown only for debugging.
# Usage: open this file (double-click) -> control panel appears.
# LUU Y: file nay chi dung ASCII (khong dau) de tranh loi font tren PowerShell 5.1.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
$SERVE_LOG = Join-Path $ROOT "serve.log"
$BRIDGE_LOG = Join-Path $ROOT "bridge.log"
$SERVE_PID = Join-Path $ROOT ".serve.pid"
$UI_FONT = New-Object System.Drawing.Font("Segoe UI", 9)

function Get-ServePid {
  try {
    $c = Get-NetTCPConnection -LocalPort 4096 -State Listen -ErrorAction Stop | Select-Object -First 1
    return $c.OwningProcess
  } catch { return $null }
}

function Test-Serve {
  try {
    $h = Invoke-RestMethod -Uri "http://127.0.0.1:4096/global/health" -TimeoutSec 5
    return [bool]$h.healthy
  } catch { return $false }
}

function Get-BridgePid {
  $p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*bridge.js*" } | Select-Object -First 1
  if ($p) { return $p.ProcessId } else { return $null }
}

function Start-ServeHidden {
  if (Test-Serve) { return "already running" }
  $cmd = "`$env:OPENCODE_DISABLE_AUTOUPDATE='1'; Set-Location E:\; opencode serve --port 4096 --hostname 127.0.0.1 *>&1 | Tee-Object -FilePath '$SERVE_LOG'"
  Start-Process -FilePath "powershell.exe" -ArgumentList "-NoExit", "-Command", $cmd -WindowStyle Hidden
  for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 2
    if (Test-Serve) { return "ok" }
  }
  return "timeout"
}

function Stop-ServeManaged {
  $pidFile = $null
  try { $pidFile = [int](Get-Content -LiteralPath $SERVE_PID -ErrorAction Stop).Trim() } catch {}
  $portPid = Get-ServePid
  $target = $null
  if ($pidFile) { $target = $pidFile } elseif ($portPid) { $target = $portPid }
  if (-not $target) { return "serve not found" }
  try { Stop-Process -Id $target -Force -ErrorAction Stop } catch { return "cannot stop PID $target" }
  Start-Sleep -Seconds 2
  if (Test-Serve) { return "still running (serve may be unmanaged)" }
  return "ok"
}

function Start-BridgeHidden {
  if (Get-BridgePid) { return "already running" }
  $cmd = "Set-Location '$ROOT'; npm run bridge *>&1 | Tee-Object -FilePath '$BRIDGE_LOG'"
  Start-Process -FilePath "powershell.exe" -ArgumentList "-NoExit", "-Command", $cmd -WindowStyle Hidden
  return "ok"
}

function Stop-BridgeManaged {
  $pidBridge = Get-BridgePid
  if (-not $pidBridge) { return "bridge not found" }
  try { Stop-Process -Id $pidBridge -Force -ErrorAction Stop } catch { return "cannot stop" }
  return "ok"
}

function Show-DebugLog($logPath, $title) {
  $cmd = "`$Host.UI.RawUI.WindowTitle='$title'; Get-Content -LiteralPath '$logPath' -Wait -Tail 60"
  Start-Process -FilePath "powershell.exe" -ArgumentList "-NoExit", "-Command", $cmd
}

# ---------- GUI ----------
$form = New-Object System.Windows.Forms.Form
$form.Text = "Zalo Bridge Control"
$form.Size = New-Object System.Drawing.Size(430, 340)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.Font = $UI_FONT

$lblServe = New-Object System.Windows.Forms.Label
$lblServe.Location = New-Object System.Drawing.Point(15, 18)
$lblServe.Size = New-Object System.Drawing.Size(200, 23)
$lblServe.Text = "Serve opencode : ..."
$form.Controls.Add($lblServe)

$lblBridge = New-Object System.Windows.Forms.Label
$lblBridge.Location = New-Object System.Drawing.Point(15, 48)
$lblBridge.Size = New-Object System.Drawing.Size(200, 23)
$lblBridge.Text = "Bridge Zalo : ..."
$form.Controls.Add($lblBridge)

function New-Btn($text, $x, $y, $w, $handler) {
  $b = New-Object System.Windows.Forms.Button
  $b.Location = New-Object System.Drawing.Point($x, $y)
  $b.Size = New-Object System.Drawing.Size($w, 30)
  $b.Text = $text
  $b.Add_Click($handler)
  $form.Controls.Add($b)
  return $b
}

function Refresh-Status {
  if (Test-Serve) { $lblServe.Text = "Serve opencode : [CHAY]"; $lblServe.ForeColor = "Green" }
  else { $lblServe.Text = "Serve opencode : [TAT]"; $lblServe.ForeColor = "Red" }
  if (Get-BridgePid) { $lblBridge.Text = "Bridge Zalo : [CHAY]"; $lblBridge.ForeColor = "Green" }
  else { $lblBridge.Text = "Bridge Zalo : [TAT]"; $lblBridge.ForeColor = "Red" }
}

New-Btn "Start All" 15 85 120 { Start-ServeHidden | Out-Null; Start-BridgeHidden | Out-Null; Refresh-Status }
New-Btn "Stop All" 145 85 120 { Stop-BridgeManaged | Out-Null; Stop-ServeManaged | Out-Null; Refresh-Status }
New-Btn "Restart All" 275 85 120 { Stop-BridgeManaged | Out-Null; Stop-ServeManaged | Out-Null; Start-Sleep -Seconds 2; Start-ServeHidden | Out-Null; Start-BridgeHidden | Out-Null; Refresh-Status }

New-Btn "Serve: Start" 15 125 120 { Start-ServeHidden | Out-Null; Refresh-Status }
New-Btn "Serve: Stop" 145 125 120 { Stop-ServeManaged | Out-Null; Refresh-Status }
New-Btn "Serve: Debug" 275 125 120 { Show-DebugLog $SERVE_LOG "serve-debug (log truc tiep)" }

New-Btn "Bridge: Start" 15 165 120 { Start-BridgeHidden | Out-Null; Refresh-Status }
New-Btn "Bridge: Stop" 145 165 120 { Stop-BridgeManaged | Out-Null; Refresh-Status }
New-Btn "Bridge: Debug" 275 165 120 { Show-DebugLog $BRIDGE_LOG "bridge-debug (log truc tiep)" }

$lblNote = New-Object System.Windows.Forms.Label
$lblNote.Location = New-Object System.Drawing.Point(15, 210)
$lblNote.Size = New-Object System.Drawing.Size(390, 60)
$lblNote.Text = "Hidden by default, no terminals. Debug buttons only open a live log window (close anytime, tool keeps running)."
$form.Controls.Add($lblNote)

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({ Refresh-Status })
$timer.Start()

Refresh-Status
[void]$form.ShowDialog()
