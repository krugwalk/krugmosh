@echo off
title Datamosh - remove from Premiere Pro
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\plugin_tools.ps1" uninstall
echo.
pause
