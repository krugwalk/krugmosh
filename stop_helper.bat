@echo off
title Datamosh helper - stop
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\helper_tools.ps1" stop
echo.
pause
