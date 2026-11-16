# Datamosh panel: package as a Premiere plugin (.ccx) and install / remove it with
# Adobe's own installer (Unified Plugin Installer Agent), so it lives in Premiere under
# Window > UXP Plugins > Datamosh without UXP Developer Tools.
#   plugin_tools.ps1 <package|release|install|uninstall>
#   release: a portable datamosh.ccx for GitHub (finds the helper through
#            %APPDATA%\Datamosh\home.txt, written by install-helper.bat)
param([Parameter(Mandatory = $true)][ValidateSet("package", "release", "install", "uninstall")] [string]$Action)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem
# Zip with "/" in paths (Compress-Archive in Windows PowerShell writes "\", which
# other unzip tools mishandle)
function New-Zip($dir, $zip, [switch]$WithFolder) {
    if (Test-Path $zip) { Remove-Item $zip -Force }
    [IO.Compression.ZipFile]::CreateFromDirectory($dir, $zip, [IO.Compression.CompressionLevel]::Optimal, [bool]$WithFolder)
}
$root = Split-Path -Parent $PSScriptRoot                      # ...\datamosh
$panel = Join-Path $root "panel"
$build = Join-Path $root "build"
$stage = Join-Path $build "plugin"
$ccx = Join-Path $build "datamosh.ccx"
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
    [IO.File]::WriteAllText((Join-Path $stage "config.js"), "window.DATAMOSH_HOME = `"$home_js`";`n", $utf8)
    $man = Join-Path $stage "manifest.json"
    [IO.File]::WriteAllText($man, ([IO.File]::ReadAllText($man)).TrimStart([char]0xFEFF), $utf8)
    $zip = Join-Path $build "datamosh.zip"
    if (Test-Path $zip) { Remove-Item $zip -Force }
    if (Test-Path $ccx) { Remove-Item $ccx -Force }
    New-Zip $stage $zip
    Move-Item $zip $ccx
    $ver = (Get-Content (Join-Path $panel "manifest.json") -Raw | ConvertFrom-Json).version
    Write-Host "Packaged Datamosh $ver -> $ccx"
}

function Test-Upia {
    if (-not (Test-Path $upia)) { throw "Adobe's plugin installer wasn't found. Is the Creative Cloud app installed?" }
}

switch ($Action) {
    "package" { New-Package }
    "release" {
        # GitHub release files: build\release\datamosh.ccx + Datamosh-Helper.zip
        New-Package -Portable
        $rel = Join-Path $build "release"
        if (Test-Path $rel) { Get-ChildItem $rel | Remove-Item -Recurse -Force }
        New-Item -ItemType Directory -Force $rel | Out-Null
        Copy-Item $ccx (Join-Path $rel "datamosh.ccx")
        $repo = Split-Path -Parent $root
        $h = Join-Path $build "helper\Datamosh-Helper"
        if (Test-Path (Split-Path $h)) { Remove-Item (Split-Path $h) -Recurse -Force }
        New-Item -ItemType Directory -Force (Join-Path $h "app\scripts") | Out-Null
        foreach ($f in "install-helper.bat", "uninstall.bat", "LICENSE") { Copy-Item (Join-Path $repo $f) $h }
        foreach ($f in "mosh.py", "mosh_server.py", "objects.py", "target.py", "datamosh_helper.pyw", "requirements.txt") {
            Copy-Item (Join-Path $root $f) (Join-Path $h "app")
        }
        foreach ($f in "helper_tools.ps1", "install_helper.ps1", "plugin_tools.ps1") {
            Copy-Item (Join-Path $PSScriptRoot $f) (Join-Path $h "app\scripts")
        }
        New-Zip $h (Join-Path $rel "Datamosh-Helper.zip") -WithFolder
        Write-Host "Release files in $rel"
        Get-ChildItem $rel | ForEach-Object { Write-Host ("  {0}  {1:N0} KB" -f $_.Name, ($_.Length / 1KB)) }
    }
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
