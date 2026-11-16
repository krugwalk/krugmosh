@echo off
title Datamosh - setup
echo Sets up everything Datamosh needs, once:
echo   1. checks Python and installs the Python packages
echo   2. checks ffmpeg (offers to install it)
echo   3. installs the panel into Premiere Pro (Window ^> UXP Plugins ^> Datamosh)
echo   4. makes the helper start hidden with Windows
echo.
echo Keep this folder where it is afterwards: Premiere and the helper run from here.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1"
echo.
pause
