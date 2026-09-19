# Zalo bridge WinForms panel (tele-style bot-gui.ps1).
# Lights + buttons + live log. Closing this window does NOT stop bridge/serve.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
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
    $h = Invoke-RestMethod -Uri "http://127.0.0.1:4096/global/health" -TimeoutSec 4
    if ($h.healthy) { return $true }
  } catch {}
  return $false
}

$form = New-Object Windows.Forms.Form
$form.Text = "Zalo Bridge"
$form.Size = New-Object Drawing.Size(660, 540)
$form.StartPosition = "CenterScreen"

$y = 12
$lights = @{}
foreach ($name in @("Bot", "Serve 4096", "Health")) {
  $lb = New-Object Windows.Forms.Label
  $lb.Text = $name
  $lb.Location = New-Object Drawing.Point(12, $y)
  $lb.Size = New-Object Drawing.Size(90, 23)
  $form.Controls.Add($lb)
  $lt = New-Object Windows.Forms.Label
  $lt.Text = "..."
  $lt.Location = New-Object Drawing.Point(110, $y)
  $lt.Size = New-Object Drawing.Size(200, 23)
  $form.Controls.Add($lt)
  $lights[$name] = $lt
  $y += 28
}

$logBox = New-Object Windows.Forms.TextBox
$logBox.Multiline = $true
$logBox.ScrollBars = "Vertical"
$logBox.ReadOnly = $true
$logBox.Location = New-Object Drawing.Point(12, $y + 44)
$logBox.Size = New-Object Drawing.Size(620, 300)
$logBox.Font = New-Object Drawing.Font("Consolas", 9)
$form.Controls.Add($logBox)

function Set-Light($label, $on, $text) {
  $label.ForeColor = if ($on) { [Drawing.Color]::Green } else { [Drawing.Color]::Red }
  $label.Text = $text
}

function Refresh-All {
  $pid = Get-BridgePid
  $serve = Get-ServeHealth
  if ($pid) { Set-Light $lights["Bot"] $true "BẬT (PID $pid)" } else { Set-Light $lights["Bot"] $false "TẮT" }
  if ($serve) { Set-Light $lights["Serve 4096"] $true "BẬT" } else { Set-Light $lights["Serve 4096"] $false "TẮT" }
  if ($pid -and $serve) { Set-Light $lights["Health"] $true "BẬT" } else { Set-Light $lights["Health"] $false "TẮT" }
  if (Test-Path $logFile) {
    $logBox.Text = (Get-Content $logFile | Select-Object -Last 30) -join "`r`n"
  }
}

$bx = 12
foreach ($pair in @(@("Bật", "start"), @("Tắt", "stop"), @("Khởi động lại", "restart"), @("Làm mới", "status"))) {
  $btn = New-Object Windows.Forms.Button
  $btn.Text = $pair[0]
  $btn.Location = New-Object Drawing.Point($bx, 100)
  $btn.Size = New-Object Drawing.Size(110, 30)
  $tag = $pair[1]
  $btn.Add_Click({
    param($s, $e)
    $a = $s.Tag
    if ($a -eq "status") { Refresh-All; return }
    Start-Process -FilePath "powershell" -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $root "bot.ps1"), $a -WindowStyle Hidden
    Start-Sleep -Seconds 3
    Refresh-All
  }.GetNewClosure())
  $btn.Tag = $tag
  $form.Controls.Add($btn)
  $bx += 120
}

$chk = New-Object Windows.Forms.CheckBox
$chk.Text = "Hiện cửa sổ terminal (debug)"
$chk.Location = New-Object Drawing.Point(500, 105)
$chk.Size = New-Object Drawing.Size(140, 24)
$form.Controls.Add($chk)

$hint = New-Object Windows.Forms.Label
$hint.Text = "Đóng cửa sổ này không làm tắt bot/serve."
$hint.Location = New-Object Drawing.Point(12, 470)
$hint.Size = New-Object Drawing.Size(620, 23)
$form.Controls.Add($hint)

$timer = New-Object Windows.Forms.Timer
$timer.Interval = 5000
$timer.Add_Tick({ Refresh-All })
$timer.Start()

Refresh-All
[void]$form.ShowDialog()
