@echo off
title Datamosh helper - start with Windows
echo Sets the Datamosh helper to start hidden every time Windows starts,
echo and starts it now. No window stays open.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\helper_tools.ps1" install
echo.
pause
