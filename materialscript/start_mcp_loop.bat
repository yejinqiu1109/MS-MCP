@echo off
setlocal
set "MS_MCP_ROOT=%~dp0.."
if exist "%MS_MCP_ROOT%\config\ms-mcp.local.bat" call "%MS_MCP_ROOT%\config\ms-mcp.local.bat"
if "%MS_INSTALL_ROOT%"=="" (
  echo ERROR: MS_INSTALL_ROOT is not configured.
  echo Run "%MS_MCP_ROOT%\Configure-MS-MCP.bat" first.
  exit /b 1
)
if "%MS_MCP_WORK_ROOT%"=="" set "MS_MCP_WORK_ROOT=%MS_MCP_ROOT%\workspace"
if "%MS_MCP_QUEUE_DIR%"=="" set "MS_MCP_QUEUE_DIR=%MS_MCP_WORK_ROOT%\.mcp-queue"
if not exist "%MS_INSTALL_ROOT%\etc\Scripting\bin\RunMatScript.bat" (
  echo ERROR: RunMatScript.bat was not found under "%MS_INSTALL_ROOT%".
  echo Re-run "%MS_MCP_ROOT%\Configure-MS-MCP.bat" and correct the Materials Studio path.
  exit /b 1
)
cd /d "%~dp0"
call "%MS_INSTALL_ROOT%\etc\Scripting\bin\RunMatScript.bat" mcp_loop_gui
endlocal

