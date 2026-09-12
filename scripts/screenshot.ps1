# Screenshot helper for the Zalo bridge (no extra installs, .NET only).
# Captures the PRIMARY screen, saves PNG into the bridge inbox/, prints the
# absolute path on ONE line so the AI agent can parse it.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\screenshot.ps1 [-OutDir <dir>] [-MaxEdge 1920]
param(
  [string]$OutDir = "",
  [int]$MaxEdge = 1920
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Test-BlankScreenshot([System.Drawing.Bitmap]$b) {
  # Sample a grid; blank when (almost) every pixel is pure black.
  $dark = 0
  $total = 0
  for ($x = 0; $x -lt $b.Width; $x += [Math]::Max(1, [int]($b.Width / 24))) {
    for ($y = 0; $y -lt $b.Height; $y += [Math]::Max(1, [int]($b.Height / 24))) {
      $total++
      $p = $b.GetPixel($x, $y)
      if ($p.R -lt 8 -and $p.G -lt 8 -and $p.B -lt 8) { $dark++ }
    }
  }
  return ($total -gt 0 -and ($dark / $total) -gt 0.99)
}

if ([string]::IsNullOrWhiteSpace($OutDir)) {
  $OutDir = Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) "inbox"
}
if (-not (Test-Path -LiteralPath $OutDir)) {
  New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}

$screen = [System.Windows.Forms.Screen]::PrimaryScreen
$bounds = $screen.Bounds
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
try {
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  } finally {
    $g.Dispose()
  }
  # Downscale when huge (keeps Zalo uploads fast, text stays readable).
  $edge = [Math]::Max($bmp.Width, $bmp.Height)
  if ($edge -gt $MaxEdge) {
    $ratio = $MaxEdge / $edge
    $w = [int]($bmp.Width * $ratio)
    $h = [int]($bmp.Height * $ratio)
    $small = New-Object System.Drawing.Bitmap($bmp, $w, $h)
    $bmp.Dispose()
    $bmp = $small
  }
  # Blank-screen guard: locked/off/RDP-disconnected desktops capture black.
  if (Test-BlankScreenshot $bmp) {
    Write-Output "BLANK"
    exit 2
  }
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $dest = Join-Path $OutDir ("shot-" + $stamp + ".png")
  $bmp.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output $dest
} finally {
  $bmp.Dispose()
}
