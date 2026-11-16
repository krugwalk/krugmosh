# One-click setup: Python packages, ffmpeg, Premiere plugin, helper autostart.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

function Step($n, $text) { Write-Host ""; Write-Host "[$n/4] $text" -ForegroundColor Cyan }
function Ask($q) { (Read-Host "$q [Y/n]") -notmatch '^(n|no)$' }

# 1. Python ------------------------------------------------------------------
Step 1 "Python"
$py = $null
try { $v = (& python --version 2>&1 | Out-String).Trim(); if ($v -match '^Python 3\.(\d+)') { $py = "python" } } catch { }
if (-not $py) {
    Write-Host "Python 3 was not found." -ForegroundColor Yellow
    if ((Get-Command winget -ErrorAction SilentlyContinue) -and (Ask "Install Python 3.12 with winget now?")) {
        winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
        Write-Host "Python installed. Close this window and run setup.bat again (so Windows finds it)." -ForegroundColor Yellow
        exit 1
    }
    throw "Install Python 3 from https://www.python.org/downloads/ (tick 'Add python.exe to PATH'), then run setup.bat again."
}
Write-Host "Found $v"
& python -m pip install --disable-pip-version-check -r (Join-Path $root "requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "Installing the Python packages failed (see above)." }

# 2. ffmpeg ------------------------------------------------------------------
Step 2 "ffmpeg"
$ff = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ff) {
    $wg = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
    $ff = Get-ChildItem $wg -Filter ffmpeg.exe -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match 'Gyan\.FFmpeg' } | Select-Object -First 1
}
if ($ff) {
    Write-Host "Found ffmpeg"
} elseif ((Get-Command winget -ErrorAction SilentlyContinue) -and (Ask "ffmpeg was not found. Install it with winget now?")) {
    winget install -e --id Gyan.FFmpeg --accept-package-agreements --accept-source-agreements
} else {
    Write-Host "ffmpeg is needed. Get it from https://www.gyan.dev/ffmpeg/builds/ and put its bin folder on PATH." -ForegroundColor Yellow
}

# 3. Premiere plugin ----------------------------------------------------------
Step 3 "Premiere Pro plugin"
& (Join-Path $PSScriptRoot "plugin_tools.ps1") install

# 4. Helper autostart ----------------------------------------------------------
Step 4 "Helper (starts hidden with Windows)"
& (Join-Path $PSScriptRoot "helper_tools.ps1") install

Write-Host ""
Write-Host "Done. Restart Premiere Pro, then open Window > UXP Plugins > Datamosh." -ForegroundColor Green
