@echo off
chcp 65001 > nul
cd /d "%~dp0"

echo.
echo  ╔══════════════════════════════════════╗
echo  ║    Alerte Emploi — Mode interactif   ║
echo  ║  Statuts et parametres sauvegardes   ║
echo  ╚══════════════════════════════════════╝
echo.

py job_alert.py --serve
if %errorlevel% neq 0 python job_alert.py --serve

pause
