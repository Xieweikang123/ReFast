@echo off
msiexec /i "D:\project\re-fast\src-tauri\target\release\bundle\msi\ReFast_1.0.88_x64_zh-CN.msi" /qn /norestart
set ERR=%ERRORLEVEL%
echo msiexec_exit=%ERR%
exit /b %ERR%
