@echo off
title Datamosh - uninstall
echo Removes the Datamosh panel from Premiere Pro and stops the helper
echo (and stops it starting with Windows). Close Premiere Pro first.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\scripts\plugin_tools.ps1" uninstall
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\scripts\helper_tools.ps1" uninstall
echo.
echo Done. You can delete this folder now.
pause
