# Clickable control panel for zalo-opencode-bridge (Windows).
#
# Run via double-click on bot-gui.bat, or:
#   powershell -STA -ExecutionPolicy Bypass -File .\bot-gui.ps1
#
# Closing this window does NOT stop the bridge or server.

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = "Stop"

$projectRoot = $PSScriptRoot
. (Join-Path $projectRoot "bot.ps1")

$REFRESH_INTERVAL_MS = 5000

$form = New-Object Windows.Forms.Form
$form.Text = "Zalo Bridge"
$form.Size = New-Object Drawing.Size(660, 540)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false

function New-StatusLabel($x, $y, $name) {
    $label = New-Object Windows.Forms.Label
    $label.Location = New-Object Drawing.Point($x, $y)
    $label.Size = New-Object Drawing.Size(600, 24)
    $label.Font = New-Object Drawing.Font("Segoe UI", 11)
    $label.Text = "$name : ..."
    $form.Controls.Add($label)
    return $label
}

$lblBot = New-StatusLabel 20 15 "Bridge"
$lblServer = New-StatusLabel 20 45 "Server 4096"
$lblHealth = New-StatusLabel 20 75 "Health"

function New-Button($x, $text) {
    $button = New-Object Windows.Forms.Button
    $button.Location = New-Object Drawing.Point($x, 110)
    $button.Size = New-Object Drawing.Size(140, 36)
    $button.Font = New-Object Drawing.Font("Segoe UI", 10)
    $button.Text = $text
    $form.Controls.Add($button)
    return $button
}

$btnStart = New-Button 20 "Bật"
$btnStop = New-Button 172 "Tắt"
$btnRestart = New-Button 324 "Khởi động lại"
$btnRefresh = New-Button 476 "Làm mới"

$chkDebug = New-Object Windows.Forms.CheckBox
$chkDebug.Location = New-Object Drawing.Point(20, 152)
$chkDebug.Size = New-Object Drawing.Size(600, 24)
$chkDebug.Font = New-Object Drawing.Font("Segoe UI", 9)
$chkDebug.Text = "Hiện cửa sổ terminal (debug)"
$chkDebug.Checked = $false
$form.Controls.Add($chkDebug)

$txtLog = New-Object Windows.Forms.TextBox
$txtLog.Location = New-Object Drawing.Point(20, 180)
$txtLog.Size = New-Object Drawing.Size(600, 258)
$txtLog.Multiline = $true
$txtLog.ReadOnly = $true
$txtLog.ScrollBars = "Vertical"
$txtLog.Font = New-Object Drawing.Font("Consolas", 9)
$txtLog.Text = "Đang tải log..."
$form.Controls.Add($txtLog)

$lblHint = New-Object Windows.Forms.Label
$lblHint.Location = New-Object Drawing.Point(20, 448)
$lblHint.Size = New-Object Drawing.Size(600, 24)
$lblHint.Font = New-Object Drawing.Font("Segoe UI", 9)
$lblHint.ForeColor = [Drawing.Color]::Gray
$lblHint.Text = "Đóng cửa sổ này không làm tắt bridge/server. Nút Tắt dừng cả serve :4096 chung."
$form.Controls.Add($lblHint)

function Set-Light($label, $name, $on, $detail) {
    $state = "TẮT"
    $color = [Drawing.Color]::Red
    if ($on) {
        $state = "BẬT"
        $color = [Drawing.Color]::Green
    }
    $text = "$name : $state"
    if ($detail) {
        $text += " ($detail)"
    }
    $label.Text = $text
    $label.ForeColor = $color
}

function Update-Status {
    $bot = Get-BotProcess
    $serve = Get-ServeProcess
    $health = Get-ServeHealth

    $botDetail = ""
    if ($bot) {
        $botDetail = "PID $($bot.ProcessId)"
    }
    Set-Light $lblBot "Bridge" ($null -ne $bot) $botDetail

    $serveDetail = ""
    if ($serve) {
        $serveDetail = "PID $($serve.ProcessId)"
    }
    Set-Light $lblServer "Server 4096" ($null -ne $serve) $serveDetail
    Set-Light $lblHealth "Health" ($null -ne $health) $health

    $btnStart.Enabled = ($null -eq $bot)
    $btnStop.Enabled = ($null -ne $bot) -or ($null -ne $serve)
    $btnRestart.Enabled = $btnStop.Enabled
}

function Update-Log {
    $log = Get-NewestLogFile
    if ($null -eq $log) {
        return
    }
    $text = (Get-Content -LiteralPath $log.FullName -Tail 30) -join "`r`n"
    if ($txtLog.Text -ne $text) {
        $txtLog.Text = $text
        $txtLog.SelectionStart = $txtLog.Text.Length
        $txtLog.ScrollToCaret()
    }
}

function Set-Busy($busy, $message) {
    $btnStart.Enabled = -not $busy
    $btnStop.Enabled = -not $busy
    $btnRestart.Enabled = -not $busy
    $btnRefresh.Enabled = -not $busy
    $chkDebug.Enabled = -not $busy
    if ($busy) {
        $form.Cursor = [Windows.Forms.Cursors]::WaitCursor
        $txtLog.Text = $message
    } else {
        $form.Cursor = [Windows.Forms.Cursors]::Default
    }
    [Windows.Forms.Application]::DoEvents()
}

function Invoke-Safe($action) {
    Set-Busy $true "Đang xử lý, chờ chút..."
    try {
        & $action
    } catch {
        [Windows.Forms.MessageBox]::Show($_.Exception.Message, "Lỗi", "OK", "Error") | Out-Null
    }
    Update-Status
    Update-Log
    Set-Busy $false ""
    Update-Status
}

$btnStart.Add_Click({ Invoke-Safe { Start-All -ShowConsole:$chkDebug.Checked } })
$btnStop.Add_Click({ Invoke-Safe { Stop-All } })
$btnRestart.Add_Click({ Invoke-Safe { Stop-All; Start-Sleep -Seconds 2; Start-All -ShowConsole:$chkDebug.Checked } })
$btnRefresh.Add_Click({ Update-Status; Update-Log })

$timer = New-Object Windows.Forms.Timer
$timer.Interval = $REFRESH_INTERVAL_MS
$timer.Add_Tick({ Update-Status; Update-Log })
$timer.Start()

$form.Add_Shown({ Update-Status; Update-Log })
$form.Add_FormClosed({ $timer.Stop() })

[void]$form.ShowDialog()
