@echo off
cd /d "%~dp0"

if not exist node_modules (
    echo [INFO] node_modules not found, installing dependencies...
    call npm install
    if errorlevel 1 (
        echo [ERROR] Install failed. Check your network and retry.
        pause
        exit /b 1
    )
)

echo [START] Launching ReFast dev mode...
call npm run dev:tauri

pause
