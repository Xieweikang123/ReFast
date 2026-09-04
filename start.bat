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

echo [START] Killing existing ReFast dev processes...
taskkill /F /IM re-fast.exe 2>nul
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :1420 ^| findstr LISTENING') do (
    taskkill /F /PID %%a 2>nul
)
echo [START] Launching ReFast dev mode...
call npm run dev:tauri

pause
