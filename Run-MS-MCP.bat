@echo off
setlocal
set "MS_MCP_ROOT=%~dp0"
if not exist "%MS_MCP_ROOT%config\ms-mcp.local.bat" (
  echo ERROR: Run Configure-MS-MCP.bat first. 1>&2
  exit /b 1
)
call "%MS_MCP_ROOT%config\ms-mcp.local.bat"
cd /d "%MS_MCP_ROOT%"
"%NODE_EXE%" "%MS_MCP_ROOT%src\index.js"
exit /b %ERRORLEVEL%
