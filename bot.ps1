# Start/stop/status control script for zalo-opencode-bridge (Windows).
# Ported from opencode-telegram-bot/bot.ps1 - same structure, Zalo paths.
#
# Usage:
#   .\bot.ps1 start                 # start server + bridge hidden (default)
#   .\bot.ps1 start -ShowConsole    # start with visible windows (debug)
#   .\bot.ps1 stop     # stop both (NOTE: shared :4096 serve also feeds the telegram bot)
#   .\bot.ps1 restart  # stop, then start
#   .\bot.ps1 status   # show processes, port 4096, health, recent log lines
#   .\bot.ps1 logs     # show tail of the newest bridge log file
#   .\bot.ps1          # interactive menu
#
# If Windows blocks scripts, run once with:
#   powershell -ExecutionPolicy Bypass -File .\bot.ps1 start

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet("", "start", "stop", "restart", "status", "logs")]
    [string]$Command = "",
    [switch]$ShowConsole
)

$ErrorActionPreference = "Stop"

$projectRoot = $PSScriptRoot
$bridgeEntry = Join-Path $projectRoot "src\bridge.js"
$envFile = Join-Path $projectRoot ".env"
$logsDir = Join-Path $projectRoot "logs"
$servePort = "4096"
$healthUrl = "http://localhost:$servePort/global/health"

function Find-NodeExe {
    $nvmNode = "C:\nvm4w\nodejs\node.exe"
    if (Test-Path -LiteralPath $nvmNode) {
        return $nvmNode
    }
    $cmd = Get-Command "node.exe" -ErrorAction SilentlyContinue
    if ($cmd) {
        return $cmd.Source
    }
    return $null
}

function Test-NodeVersion($nodeExe) {
    $version = & $nodeExe --version 2>$null
    if (-not $version) {
        return $false
    }
    $clean = $version.TrimStart("v")
    $parts = $clean.Split(".")
    $major = [int]$parts[0]
    $minor = [int]$parts[1]
    if ($major -gt 22) {
        return $true
    }
    if ($major -eq 22 -and $minor -ge 14) {
        return $true
    }
    Write-Host "Node.js $version is too old. Need 22.14+ (nvm use 22.23.2)." -ForegroundColor Red
    return $false
}

function Find-OpencodeExe {
    $cmd = Get-Command "opencode.exe" -ErrorAction SilentlyContinue
    if ($cmd) {
        return $cmd.Source
    }
    $fallback = Join-Path $env:APPDATA "npm\node_modules\opencode-ai\bin\opencode.exe"
    if (Test-Path -LiteralPath $fallback) {
        return $fallback
    }
    return $null
}

function Get-BridgePidFile {
    $f = Join-Path $projectRoot "bridge.pid"
    if (!(Test-Path -LiteralPath $f)) { return $null }
    try {
        $p = [int](Get-Content -LiteralPath $f)
        if (Get-Process -Id $p -ErrorAction SilentlyContinue) { return $p }
    } catch {}
    return $null
}

function Get-BotProcess {
    # Primary: bridge.pid written by the bridge itself.
    $viaPid = Get-BridgePidFile
    if ($viaPid) {
        return [pscustomobject]@{ ProcessId = $viaPid }
    }
    # Fallback: command-line scan. Match full Windows path (this script's
    # starts) AND bare relative path (legacy restart-bridge.ps1 starts):
    # manual starts use src/bridge.js, this script passes src\bridge.js.
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*zalo-opencode-bridge*src/bridge.js*" -or $_.CommandLine -like "*zalo-opencode-bridge*src\bridge.js*" -or $_.CommandLine -like "* src/bridge.js*" -or $_.CommandLine -like "* src\bridge.js*" }
}

function Get-ServeProcess {
    Get-CimInstance Win32_Process -Filter "Name='opencode.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*serve*" -and $_.CommandLine -like "*$servePort*" }
}

function Test-PortListening {
    $lines = netstat -ano | Select-String "LISTENING" | Select-String ":$servePort "
    return ($null -ne $lines)
}

function Get-ServeHealth {
    try {
        $result = curl.exe -s -m 5 $healthUrl 2>$null
        if ($result -match '"healthy":true') {
            return $result
        }
    } catch {
    }
    return $null
}

function Get-NewestLogFile {
    if (-not (Test-Path -LiteralPath $logsDir)) {
        return $null
    }
    Get-ChildItem -LiteralPath $logsDir -Filter "bridge-*.log" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
}

function Show-Status {
    Write-Host ""
    Write-Host "=== Zalo Bridge status ===" -ForegroundColor Cyan

    $bot = Get-BotProcess
    if ($bot) {
        Write-Host ("Bot      : RUNNING (PID {0})" -f $bot.ProcessId) -ForegroundColor Green
    } else {
        Write-Host "Bot      : stopped" -ForegroundColor Yellow
    }

    $serve = Get-ServeProcess
    if ($serve) {
        Write-Host ("Server   : RUNNING (PID {0})" -f $serve.ProcessId) -ForegroundColor Green
    } else {
        Write-Host "Server   : stopped" -ForegroundColor Yellow
    }

    if (Test-PortListening) {
        Write-Host "Port 4096: LISTENING" -ForegroundColor Green
    } else {
        Write-Host "Port 4096: free" -ForegroundColor Yellow
    }

    $health = Get-ServeHealth
    if ($health) {
        Write-Host ("Health   : {0}" -f $health) -ForegroundColor Green
    } else {
        Write-Host "Health   : unreachable" -ForegroundColor Yellow
    }

    try {
        $st = Get-Content (Join-Path $projectRoot ".bridge-store.json") -Raw | ConvertFrom-Json
        $pg = @($st.projectGroups.PSObject.Properties).Count
        Write-Host ("Sessions : {0} | Groups: {1} | Tasks: {2}" -f @($st.sessions.PSObject.Properties).Count, $pg, @($st.tasks).Count)
    } catch {}

    $log = Get-NewestLogFile
    if ($log) {
        Write-Host ("Log      : {0}" -f $log.FullName)
        Write-Host "--- last 5 lines ---"
        Get-Content -LiteralPath $log.FullName -Tail 5
    } else {
        Write-Host "Log      : (no log file yet)"
    }
    Write-Host ""
}

function Show-Logs {
    $log = Get-NewestLogFile
    if (-not $log) {
        Write-Host "No bridge log file found in $logsDir yet." -ForegroundColor Yellow
        return
    }
    Write-Host ("--- {0} (last 30 lines) ---" -f $log.Name) -ForegroundColor Cyan
    Get-Content -LiteralPath $log.FullName -Tail 30
}

function Stop-All {
    $stopped = @()

    $bot = Get-BotProcess
    if ($bot) {
        Stop-Process -Id $bot.ProcessId -Force
        $stopped += "bridge (PID $($bot.ProcessId))"
    }

    $serve = Get-ServeProcess
    if ($serve) {
        Stop-Process -Id $serve.ProcessId -Force
        $stopped += ("opencode serve (PID {0})" -f $serve.ProcessId)
    }

    if ($stopped.Count -eq 0) {
        Write-Host "Nothing to stop: bridge and server are already stopped." -ForegroundColor Yellow
    } else {
        Write-Host ("Stopped: {0}" -f ($stopped -join ", ")) -ForegroundColor Green
        Write-Host "NOTE: the shared :4096 serve also feeds the telegram bot." -ForegroundColor Yellow
    }
}

function Get-ConsoleLogDir {
    $dir = Join-Path ([IO.Path]::GetTempPath()) "zalo-opencode-bridge"
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
    return $dir
}

function Start-HiddenProcess($exePath, [string[]]$exeArgs, $logName) {
    $logDir = Get-ConsoleLogDir
    Start-Process -FilePath $exePath `
        -ArgumentList $exeArgs `
        -WorkingDirectory $projectRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $logDir "$logName.out.log") `
        -RedirectStandardError (Join-Path $logDir "$logName.err.log")
}

function Start-All {
    param([switch]$ShowConsole)

    $nodeExe = Find-NodeExe
    if (-not $nodeExe) {
        throw "node.exe not found. Open a new terminal (NVM needs a fresh shell) and try again."
    }
    if (-not (Test-NodeVersion $nodeExe)) {
        throw "Node.js version check failed."
    }

    $opencodeExe = Find-OpencodeExe
    if (-not $opencodeExe) {
        throw "opencode.exe not found. Reinstall OpenCode: https://opencode.ai"
    }

    if (-not (Test-Path -LiteralPath $envFile)) {
        throw "Missing .env. Copy .env.example to .env and fill in ZALO_GROUP_ID (single) or ZALO_OWNER_IDS (dual)."
    }
    $hasGroup = Select-String -LiteralPath $envFile -Pattern "^ZALO_GROUP_ID=.+" -ErrorAction SilentlyContinue
    $hasOwner = Select-String -LiteralPath $envFile -Pattern "^ZALO_OWNER_IDS=.+" -ErrorAction SilentlyContinue
    if (-not $hasGroup -and -not $hasOwner) {
        throw ".env has neither ZALO_GROUP_ID nor ZALO_OWNER_IDS. Fill one in first."
    }

    if (Get-BotProcess) {
        Write-Host "Bridge is already running. Use '.\bot.ps1 restart' to restart it." -ForegroundColor Yellow
        return
    }

    if (-not (Get-ServeProcess)) {
        Write-Host "Starting OpenCode server on port $servePort..."
        if ($ShowConsole) {
            Start-Process -FilePath "powershell.exe" `
                -ArgumentList "-NoExit", "-Command", "& '$opencodeExe' serve --port $servePort" `
                -WorkingDirectory $projectRoot
        } else {
            Start-HiddenProcess $opencodeExe @("serve", "--port", $servePort) "opencode-serve"
        }
    } else {
        Write-Host "OpenCode server is already running."
    }

    Write-Host "Waiting for OpenCode health..."
    $healthy = $null
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 1
        $healthy = Get-ServeHealth
        if ($healthy) {
            break
        }
    }
    if (-not $healthy) {
        throw "OpenCode server did not become healthy in 30s. Check its window for errors."
    }
    Write-Host ("OpenCode is healthy: {0}" -f $healthy) -ForegroundColor Green

    Write-Host "Starting bridge..."
    if ($ShowConsole) {
        Start-Process -FilePath "powershell.exe" `
            -ArgumentList "-NoExit", "-Command", "& '$nodeExe' '$bridgeEntry'" `
            -WorkingDirectory $projectRoot
    } else {
        Start-HiddenProcess $nodeExe @($bridgeEntry) "bridge"
    }

    Start-Sleep -Seconds 8
    Show-Status
}

function Show-Menu {
    # Never block on Read-Host when there's no interactive console
    # (hidden autostart/task runs) - show status instead of hanging.
    try {
        if ([Console]::IsInputRedirected -or -not [Environment]::UserInteractive) {
            Show-Status
            return
        }
    } catch {
        Show-Status
        return
    }
    Write-Host ""
    Write-Host "Zalo Bridge" -ForegroundColor Cyan
    Write-Host "  1) start"
    Write-Host "  2) stop"
    Write-Host "  3) restart"
    Write-Host "  4) status"
    Write-Host "  5) logs"
    Write-Host "  0) exit"
    Write-Host ""
    $choice = Read-Host "Choose"
    switch ($choice) {
        "1" { Start-All }
        "2" { Stop-All }
        "3" { Stop-All; Start-Sleep -Seconds 2; Start-All }
        "4" { Show-Status }
        "5" { Show-Logs }
        default { return }
    }
}

# Only run the command switch when executed directly.
# When dot-sourced (. .\bot.ps1) from bot-gui.ps1, just load the functions.
if ($MyInvocation.InvocationName -ne ".") {
    switch ($Command) {
        "start" { Start-All -ShowConsole:$ShowConsole }
        "stop" { Stop-All }
        "restart" { Stop-All; Start-Sleep -Seconds 2; Start-All -ShowConsole:$ShowConsole }
        "status" { Show-Status }
        "logs" { Show-Logs }
        default { Show-Menu }
    }
}
