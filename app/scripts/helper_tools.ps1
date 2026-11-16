# Krugmosh helper management: install/uninstall autostart, start hidden, stop.
# Called by the .bat files in the krugmosh folder:  helper_tools.ps1 <install|uninstall|start|stop>
param([Parameter(Mandatory = $true)][ValidateSet("install", "uninstall", "start", "stop")] [string]$Action)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot                      # ...\krugmosh
$pyw = Join-Path $root "krugmosh_helper.pyw"
$shortcut = Join-Path ([Environment]::GetFolderPath("Startup")) "Krugmosh helper.lnk"
# tells the Premiere panel (installed from the .ccx) where the helper is
$homeFile = Join-Path $env:APPDATA "Krugmosh\home.txt"
# left over from when this was called Datamosh
$oldShortcut = Join-Path ([Environment]::GetFolderPath("Startup")) "Datamosh helper.lnk"
$oldHome = Join-Path $env:APPDATA "Datamosh"
function Remove-OldNames {
    if (Test-Path $oldShortcut) { Remove-Item $oldShortcut -Force; Write-Host "Removed the old 'Datamosh helper' startup entry." }
    if (Test-Path $oldHome) { Remove-Item $oldHome -Recurse -Force }
}

function Get-Pythonw {
    $python = (Get-Command python -ErrorAction SilentlyContinue).Source
    if (-not $python) { throw "Python was not found on PATH." }
    $pythonw = Join-Path (Split-Path -Parent $python) "pythonw.exe"
    if (-not (Test-Path $pythonw)) { throw "pythonw.exe not found next to $python" }
    return $pythonw
}

function Get-HelperProcesses {
    Get-CimInstance Win32_Process -Filter "Name LIKE 'python%'" |
        Where-Object { $_.CommandLine -match '(krugmosh|datamosh)_helper\.pyw|mosh_server\.py' }
}

function Stop-Helper {
    $procs = @(Get-HelperProcesses)
    foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    return $procs.Count
}

function Start-Helper {
    $pythonw = Get-Pythonw
    Start-Process -FilePath $pythonw -ArgumentList "`"$pyw`"" -WorkingDirectory $root -WindowStyle Hidden
}

switch ($Action) {
    "install" {
        $pythonw = Get-Pythonw
        $shell = New-Object -ComObject WScript.Shell
        $lnk = $shell.CreateShortcut($shortcut)
        $lnk.TargetPath = $pythonw
        $lnk.Arguments = "`"$pyw`""
        $lnk.WorkingDirectory = $root
        $lnk.Description = "Krugmosh helper for Premiere Pro (runs hidden)"
        $lnk.Save()
        Remove-OldNames
        New-Item -ItemType Directory -Force (Split-Path $homeFile) | Out-Null
        [IO.File]::WriteAllText($homeFile, $root, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "Added to Windows startup: $shortcut"
        $n = Stop-Helper
        if ($n) { Write-Host "Stopped $n running helper(s) so the hidden one can take over." }
        Start-Helper
        Write-Host "Helper started in the background (no window). Log: $root\helper.log"
    }
    "uninstall" {
        if (Test-Path $shortcut) { Remove-Item $shortcut -Force; Write-Host "Removed from Windows startup." }
        else { Write-Host "It was not set to start with Windows." }
        Remove-OldNames
        $dir = Split-Path $homeFile
        if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
        $n = Stop-Helper
        Write-Host "Stopped $n running helper(s)."
    }
    "start" {
        Start-Helper
        Write-Host "Helper started in the background (no window)."
    }
    "stop" {
        $n = Stop-Helper
        Write-Host "Stopped $n running helper(s)."
    }
}
