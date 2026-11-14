@echo off
title Datamosh helper - remove from startup
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\helper_tools.ps1" uninstall
echo.
pause
