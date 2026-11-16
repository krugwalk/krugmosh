@echo off
title Krugmosh helper - install
echo Installs the Krugmosh helper (it does the encoding for the Premiere panel):
echo   1. checks Python 3 and installs two Python packages
echo   2. checks ffmpeg (offers to install it)
echo   3. starts the helper hidden, now and every time Windows starts
echo.
echo Keep this folder where it is afterwards: the helper runs from here.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\scripts\install_helper.ps1"
echo.
pause
