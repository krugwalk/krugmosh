# Datamosh panel: package as a Premiere plugin (.ccx) and install / remove it with
# Adobe's own installer (Unified Plugin Installer Agent), so it lives in Premiere under
# Window > UXP Plugins > Datamosh without UXP Developer Tools.
#   plugin_tools.ps1 <package|install|uninstall>
param([Parameter(Mandatory = $true)][ValidateSet("package", "install", "uninstall")] [string]$Action)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot                      # ...\datamosh
$panel = Join-Path $root "panel"
$build = Join-Path $root "build"
$stage = Join-Path $build "plugin"
$ccx = Join-Path $build "datamosh.ccx"
$upia = Join-Path ${env:CommonProgramFiles} `
    "Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"

function New-Package {
    if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
    New-Item -ItemType Directory -Force $stage | Out-Null
    Copy-Item (Join-Path $panel "*") $stage -Recurse -Force
    # the installed copy lives in Premiere's plugin folder: tell it where the helper is
    $home_js = ($root -replace '\\', '\\')
    # UTF-8 WITHOUT a byte-order mark (Windows PowerShell's -Encoding UTF8 adds one, and
    # Adobe's installer rejects a manifest that starts with it)
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText((Join-Path $stage "config.js"), "window.DATAMOSH_HOME = `"$home_js`";`n", $utf8)
    $man = Join-Path $stage "manifest.json"
    [IO.File]::WriteAllText($man, ([IO.File]::ReadAllText($man)).TrimStart([char]0xFEFF), $utf8)
    $zip = Join-Path $build "datamosh.zip"
    if (Test-Path $zip) { Remove-Item $zip -Force }
    if (Test-Path $ccx) { Remove-Item $ccx -Force }
    Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip
    Move-Item $zip $ccx
    $ver = (Get-Content (Join-Path $panel "manifest.json") -Raw | ConvertFrom-Json).version
    Write-Host "Packaged Datamosh $ver -> $ccx"
}

function Test-Upia {
    if (-not (Test-Path $upia)) { throw "Adobe's plugin installer wasn't found. Is the Creative Cloud app installed?" }
}

switch ($Action) {
    "package" { New-Package }
    "install" {
        Test-Upia
        New-Package
        Write-Host "Installing with Adobe's plugin installer..."
        $out = (& $upia /install $ccx 2>&1 | Out-String)
        Write-Host $out.Trim()
        # the installer exits 0 even when it fails, so read what it says
        if ($LASTEXITCODE -ne 0 -or $out -match "Failed") {
            throw "Adobe's installer could not install it (see the message above). If Premiere Pro is open, close it and try again."
        }
        Write-Host "Installed. Restart Premiere Pro, then open Window > UXP Plugins > Datamosh."
    }
    "uninstall" {
        Test-Upia
        & $upia /remove "Datamosh"
        Write-Host "Removed the Datamosh plugin (restart Premiere Pro)."
    }
}
