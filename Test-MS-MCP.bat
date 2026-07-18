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
cd /d "%MS_MCP_ROOT%"
call "%NPM_CMD%" run check || goto :failed
call "%NPM_CMD%" run smoke || goto :failed
call "%NPM_CMD%" run security-smoke || goto :failed
call "%NPM_CMD%" run mcp-smoke || goto :failed
echo.
echo SUCCESS: package, paths, security defaults, and MCP transport passed.
pause
exit /b 0

:failed
echo.
echo FAILED: Review the first error above. See README.md troubleshooting.
pause
exit /b 1
