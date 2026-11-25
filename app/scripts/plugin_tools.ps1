# Krugmosh panel: package as a Premiere plugin (.ccx) and install / remove it with
# Adobe's own installer (Unified Plugin Installer Agent), so it lives in Premiere under
# Window > UXP Plugins > Krugmosh without UXP Developer Tools.
#   plugin_tools.ps1 <package|portable|install|uninstall>
#   portable: a portable krugmosh.ccx (finds the helper through %APPDATA%\Krugmosh\home.txt,
#             written by Krugmosh-Setup.exe). setup\build.ps1 embeds it in the installer.
param([Parameter(Mandatory = $true)][ValidateSet("package", "portable", "install", "uninstall")] [string]$Action)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem
# Zip with "/" in paths (Compress-Archive in Windows PowerShell writes "\", which
# other unzip tools mishandle)
function New-Zip($dir, $zip, [switch]$WithFolder) {
    if (Test-Path $zip) { Remove-Item $zip -Force }
    [IO.Compression.ZipFile]::CreateFromDirectory($dir, $zip, [IO.Compression.CompressionLevel]::Optimal, [bool]$WithFolder)
}
$root = Split-Path -Parent $PSScriptRoot                      # ...\krugmosh
$panel = Join-Path $root "panel"
$build = Join-Path $root "build"
$stage = Join-Path $build "plugin"
$ccx = Join-Path $build "krugmosh.ccx"
$upia = Join-Path ${env:CommonProgramFiles} `
    "Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"

function New-Package([switch]$Portable) {
    if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
    New-Item -ItemType Directory -Force $stage | Out-Null
    Copy-Item (Join-Path $panel "*") $stage -Recurse -Force
    # the installed copy lives in Premiere's plugin folder: tell it where the helper is
    $home_js = if ($Portable) { "" } else { ($root -replace '\\', '\\') }
    # UTF-8 WITHOUT a byte-order mark (Windows PowerShell's -Encoding UTF8 adds one, and
    # Adobe's installer rejects a manifest that starts with it)
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText((Join-Path $stage "config.js"), "window.KRUGMOSH_HOME = `"$home_js`";`n", $utf8)
    $man = Join-Path $stage "manifest.json"
    [IO.File]::WriteAllText($man, ([IO.File]::ReadAllText($man)).TrimStart([char]0xFEFF), $utf8)
    $zip = Join-Path $build "krugmosh.zip"
    if (Test-Path $zip) { Remove-Item $zip -Force }
    if (Test-Path $ccx) { Remove-Item $ccx -Force }
    New-Zip $stage $zip
    Move-Item $zip $ccx
    $ver = (Get-Content (Join-Path $panel "manifest.json") -Raw | ConvertFrom-Json).version
    Write-Host "Packaged Krugmosh $ver -> $ccx"
}

function Test-Upia {
    if (-not (Test-Path $upia)) { throw "Adobe's plugin installer wasn't found. Is the Creative Cloud app installed?" }
}

switch ($Action) {
    "package" { New-Package }
    "portable" { New-Package -Portable }
    "install" {
        Test-Upia
        New-Package
        & $upia /remove "Datamosh" | Out-Null      # the old name, if still installed
        Write-Host "Installing with Adobe's plugin installer..."
        $out = (& $upia /install $ccx 2>&1 | Out-String)
        Write-Host $out.Trim()
        # the installer exits 0 even when it fails, so read what it says
        if ($LASTEXITCODE -ne 0 -or $out -match "Failed") {
            throw "Adobe's installer could not install it (see the message above). If Premiere Pro is open, close it and try again."
        }
        Write-Host "Installed. Restart Premiere Pro, then open Window > UXP Plugins > Krugmosh."
    }
    "uninstall" {
        Test-Upia
        & $upia /remove "Krugmosh"
        & $upia /remove "Datamosh" | Out-Null      # the old name, if still installed
        Write-Host "Removed the Krugmosh plugin (restart Premiere Pro)."
    }
}
