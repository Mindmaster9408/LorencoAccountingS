@echo off
cd /d "%~dp0"
echo.
echo  Starting Lorenco Paytime — Cloud Payroll Server...
echo.

REM Install dependencies if needed
if not exist node_modules (
    echo  Installing dependencies...
    npm install
    echo.
)

npm start
pause
