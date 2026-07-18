@echo off
setlocal
chcp 65001 >nul
set "MS_MCP_ROOT=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%MS_MCP_ROOT%scripts\configure-ms-mcp.ps1" %*
if errorlevel 1 (
  echo.
  echo Configuration failed. Correct the item reported above and run this file again.
  pause
  exit /b 1
)
echo.
echo Configuration files were generated successfully.
echo Next: run Install-MS-MCP.bat, then Test-MS-MCP.bat.
pause
exit /b 0
