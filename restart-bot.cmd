@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-bot.ps1" -Restart
if errorlevel 1 pause
