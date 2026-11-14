@echo off
title Datamosh - install into Premiere Pro
echo Packages the Datamosh panel and installs it into Premiere Pro, so it is always
echo available under Window ^> UXP Plugins ^> Datamosh (no UXP Developer Tools needed).
echo Run this again after updating the panel.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\plugin_tools.ps1" install
echo.
pause
