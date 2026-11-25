# Builds build\Krugmosh-Setup.exe: one installer with the Premiere panel (.ccx) and the helper
# embedded. Needs nothing but Windows (uses the C# compiler that ships with .NET Framework).
#   powershell -File setup\build.ps1
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem

$repo = Split-Path -Parent $PSScriptRoot
$app = Join-Path $repo "app"
$out = Join-Path $repo "build"
$tmp = Join-Path $out "setup-parts"
$exe = Join-Path $out "Krugmosh-Setup.exe"

$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe" }
if (-not (Test-Path $csc)) { throw "csc.exe (.NET Framework 4) not found." }

if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
New-Item -ItemType Directory -Force $tmp | Out-Null

# 1. the portable panel package (it finds the helper through %APPDATA%\Krugmosh\home.txt)
& (Join-Path $app "scripts\plugin_tools.ps1") portable
$ccx = Join-Path $app "build\krugmosh.ccx"
if (-not (Test-Path $ccx)) { throw "krugmosh.ccx was not built." }

# 2. the helper files, zipped ("/" paths)
$helper = Join-Path $tmp "helper"
New-Item -ItemType Directory -Force $helper | Out-Null
foreach ($f in "mosh.py", "mosh_server.py", "objects.py", "target.py", "krugmosh_helper.pyw", "requirements.txt") {
    Copy-Item (Join-Path $app $f) $helper
}
$helperZip = Join-Path $tmp "helper.zip"
[IO.Compression.ZipFile]::CreateFromDirectory($helper, $helperZip, [IO.Compression.CompressionLevel]::Optimal, $false)

# 3. version, from the panel manifest
$ver = (Get-Content (Join-Path $app "panel\manifest.json") -Raw | ConvertFrom-Json).version
$verFile = Join-Path $tmp "version.txt"
[IO.File]::WriteAllText($verFile, $ver)

# 4. compile
New-Item -ItemType Directory -Force $out | Out-Null
if (Test-Path $exe) { Remove-Item $exe -Force }
& $csc /nologo /target:winexe /optimize+ /platform:anycpu "/out:$exe" `
    "/win32manifest:$(Join-Path $PSScriptRoot 'app.manifest')" `
    /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll `
    /r:System.Management.dll /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll `
    "/resource:$ccx,krugmosh.ccx" "/resource:$helperZip,helper.zip" "/resource:$verFile,version.txt" `
    (Join-Path $PSScriptRoot "Setup.cs")
if ($LASTEXITCODE -ne 0) { throw "Compiling failed." }

Remove-Item $tmp -Recurse -Force
Write-Host ("Built {0}  v{1}  {2:N0} KB" -f $exe, $ver, ((Get-Item $exe).Length / 1KB))
