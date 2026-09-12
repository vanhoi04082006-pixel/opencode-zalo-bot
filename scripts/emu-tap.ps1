# Tap inside the LDPlayer window using DEVICE coordinates (1600x900 space).
# Reads the live window rect every call, so it survives window moves.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\emu-tap.ps1 -X 800 -Y 770 [-Double]
param(
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [switch]$Double
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class EmuWin {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  public struct RECT { public int L; public int T; public int R; public int B; }
}
"@

# Measured chrome for dnplayer window (title + tabs on top, thin side borders).
# Content keeps 16:9 aspect; scale adapts to live window size.
$TOP_CHROME = 46
$SIDE_CHROME = 32
$DEV_W = 1600
$DEV_H = 900

$p = Get-Process -Name dnplayer -ErrorAction Stop | Select-Object -First 1
$r = New-Object EmuWin+RECT
[EmuWin]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
$rectW = $r.R - $r.L
$scale = ($rectW - $SIDE_CHROME) / $DEV_W
$contentL = $r.L + $SIDE_CHROME / 2
$contentT = $r.T + $TOP_CHROME
$winX = [int]($contentL + $X * $scale)
$winY = [int]($contentT + $Y * $scale)

[EmuWin]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 300
$old = [System.Windows.Forms.Cursor]::Position
[EmuWin]::SetCursorPos($winX, $winY) | Out-Null
Start-Sleep -Milliseconds 150
[EmuWin]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 60
[EmuWin]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
if ($Double) {
  Start-Sleep -Milliseconds 120
  [EmuWin]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [EmuWin]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}
[EmuWin]::SetCursorPos($old.X, $old.Y) | Out-Null
Write-Output ("EMU_TAP dev=" + $X + "," + $Y + " win=" + $winX + "," + $winY)
