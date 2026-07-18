@echo off
setlocal
chcp 65001 >nul
set "MS_MCP_ROOT=%~dp0"

if not exist "%MS_MCP_ROOT%config\ms-mcp.local.bat" (
  echo ERROR: Run Configure-MS-MCP.bat first.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%MS_MCP_ROOT%Install-Dashboard-Autostart.ps1"
if errorlevel 1 (
  echo Failed to install Dashboard autostart.
  pause
  exit /b 1
)
echo Dashboard autostart installed successfully.
pause
exit /b 0
