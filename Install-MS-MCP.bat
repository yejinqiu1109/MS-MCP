@echo off
setlocal
chcp 65001 >nul
set "MS_MCP_ROOT=%~dp0"
set "CONFIG_FILE=%MS_MCP_ROOT%config\ms-mcp.local.bat"
if not exist "%CONFIG_FILE%" (
  echo ERROR: Run Configure-MS-MCP.bat first.
  pause
  exit /b 1
)
call "%CONFIG_FILE%"
if not exist "%NPM_CMD%" (
  echo ERROR: npm.cmd was not found at "%NPM_CMD%".
  echo Install Node.js with npm, then re-run Configure-MS-MCP.bat.
  pause
  exit /b 1
)
cd /d "%MS_MCP_ROOT%"
call "%NPM_CMD%" ci
if errorlevel 1 (
  echo ERROR: npm dependency installation failed.
  pause
  exit /b 1
)
call "%NPM_CMD%" run check
if errorlevel 1 (
  echo ERROR: package validation failed.
  pause
  exit /b 1
)
echo Installation completed successfully.
pause
exit /b 0
