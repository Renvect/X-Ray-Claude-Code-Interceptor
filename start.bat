@echo off

:: Kill anything already on port 3579
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :3579 ^| findstr LISTENING') do (
  taskkill /PID %%p /F >nul 2>&1
)

:: Start proxy minimized in background
start "XRAY Proxy" /min cmd /c "node "%~dp0proxy.js""
timeout /t 2 /nobreak >nul

:: Set proxy routing for this session (preload path encoding handled by claude-monitor.js)
set ANTHROPIC_BASE_URL=http://127.0.0.1:3579
set XRAY_LOG_DIR=%~dp0

echo.
echo  [XRAY] proxy ready ^|  dashboard: http://localhost:3579
echo  [XRAY] launching claude with full instrumentation...
echo.

:: Launch claude via monitor — stays in THIS window, handles preload URL-encoding correctly
node "%~dp0claude-monitor.js"

:: Keep window open after claude exits so you can relaunch
cmd /k
