@echo off
setlocal
chcp 65001 >nul

set "MS_MCP_ROOT=%~dp0"
set "CONFIG_FILE=%MS_MCP_ROOT%config\ms-mcp.local.bat"
if not exist "%CONFIG_FILE%" (
  echo ERROR: Local configuration was not found.
  echo Run "%MS_MCP_ROOT%Configure-MS-MCP.bat" first.
  pause
  exit /b 1
)
call "%CONFIG_FILE%"

set "OPEN_BROWSER=1"
if /i "%~1"=="--background" set "OPEN_BROWSER=0"
if "%MS_MCP_DASHBOARD_PORT%"=="" set "MS_MCP_DASHBOARD_PORT=4877"
set "DASHBOARD_JS=%MS_MCP_ROOT%GUI-Dashboard\server.js"

if not exist "%NODE_EXE%" (
  echo ERROR: Node.js was not found at "%NODE_EXE%".
  echo Re-run Configure-MS-MCP.bat after installing Node.js 20 or newer.
  pause
  exit /b 1
)

netstat -ano | findstr "127.0.0.1:%MS_MCP_DASHBOARD_PORT%" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo A service is already listening on 127.0.0.1:%MS_MCP_DASHBOARD_PORT%.
  if "%OPEN_BROWSER%"=="1" start "" "http://127.0.0.1:%MS_MCP_DASHBOARD_PORT%/"
  exit /b 0
)

start "MS-MCP Dashboard" /min "%NODE_EXE%" "%DASHBOARD_JS%"
timeout /t 2 /nobreak >nul
if "%OPEN_BROWSER%"=="1" start "" "http://127.0.0.1:%MS_MCP_DASHBOARD_PORT%/"
exit /b 0
