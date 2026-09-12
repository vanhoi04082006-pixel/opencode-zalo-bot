# Click helper for the Zalo bridge (no extra installs, user32 only).
# Moves the cursor, clicks, then restores the cursor by default.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\click.ps1 -X 960 -Y 540 [-Button Left|Right|Middle] [-Double] [-NoRestore]
param(
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [ValidateSet("Left", "Right", "Middle")][string]$Button = "Left",
  [switch]$Double,
  [switch]$NoRestore
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms

$sig = @"
using System;
using System.Runtime.InteropServices;
public static class NativeMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
"@
if (-not ([System.Management.Automation.PSTypeName]"NativeMouse").Type) {
  Add-Type -TypeDefinition $sig
}

$DOWN = @{ Left = 0x0002; Right = 0x0008; Middle = 0x0020 }
$UP = @{ Left = 0x0004; Right = 0x0010; Middle = 0x0040 }

function Invoke-ClickOnce {
  [NativeMouse]::mouse_event($DOWN[$Button], 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [NativeMouse]::mouse_event($UP[$Button], 0, 0, 0, [UIntPtr]::Zero)
}

$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
if ($X -lt 0 -or $Y -lt 0 -or $X -ge $screen.Width -or $Y -ge $screen.Height) {
  Write-Output ("OUT_OF_RANGE " + $screen.Width + "x" + $screen.Height)
  exit 2
}

$old = [System.Windows.Forms.Cursor]::Position
[NativeMouse]::SetCursorPos($X, $Y) | Out-Null
Start-Sleep -Milliseconds 150
Invoke-ClickOnce
if ($Double) {
  Start-Sleep -Milliseconds 120
  Invoke-ClickOnce
}
if (-not $NoRestore) {
  [NativeMouse]::SetCursorPos($old.X, $old.Y) | Out-Null
}
Write-Output ("CLICKED " + $X + "," + $Y + " " + $Button + $(if ($Double) { " x2" } else { "" }))
