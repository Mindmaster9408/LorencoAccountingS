@echo off
title Charlie Print Relay
cd /d "%~dp0"

if not exist config.json (
    echo config.json not found — copying config.example.json.
    echo IMPORTANT: edit config.json and set your printer's share name before printing will work.
    copy config.example.json config.json >nul
)

node relay.js
if errorlevel 1 (
    echo.
    echo Something went wrong. Common causes:
    echo   - Node.js is not installed ^(download from https://nodejs.org^)
    echo   - config.json has the wrong printer share name
    pause
)
