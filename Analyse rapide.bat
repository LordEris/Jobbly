@echo off
chcp 65001 > nul
cd /d "%~dp0"

echo.
echo  ╔══════════════════════════════════════╗
echo  ║    Alerte Emploi — Analyse rapide    ║
echo  ╚══════════════════════════════════════╝
echo.

py job_alert.py
if %errorlevel% neq 0 python job_alert.py

pause
