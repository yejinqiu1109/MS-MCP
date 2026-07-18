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

if "%MS_MCP_REMOTE_SSH_TARGET%"=="" (
  echo ERROR: No remote SSH target is configured.
  echo Re-run Configure-MS-MCP.bat and enter user@host when remote monitoring is needed.
  pause
  exit /b 1
)
if "%MS_MCP_REMOTE_SSH_KEY%"=="" set "MS_MCP_REMOTE_SSH_KEY=%USERPROFILE%\.ssh\id_ed25519_ms_mcp"
for %%I in ("%MS_MCP_REMOTE_SSH_KEY%") do set "SSH_DIR=%%~dpI"

echo ============================================================
echo MS-MCP Dashboard SSH setup
echo Target: %MS_MCP_REMOTE_SSH_TARGET%
echo Key:    %MS_MCP_REMOTE_SSH_KEY%
echo ============================================================
echo.

where ssh.exe >nul 2>&1 || (
  echo ERROR: Windows OpenSSH Client was not found.
  echo Install it in Windows Optional Features, then run this file again.
  pause
  exit /b 1
)
if not exist "%SSH_DIR%" mkdir "%SSH_DIR%"
if not exist "%MS_MCP_REMOTE_SSH_KEY%" (
  ssh-keygen.exe -t ed25519 -f "%MS_MCP_REMOTE_SSH_KEY%" -N "" -C "MS-MCP-Dashboard"
  if errorlevel 1 goto :failed
)

echo The remote account password may be requested once.
type "%MS_MCP_REMOTE_SSH_KEY%.pub" | ssh.exe "%MS_MCP_REMOTE_SSH_TARGET%" "umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys; chmod 700 ~/.ssh; chmod 600 ~/.ssh/authorized_keys"
if errorlevel 1 goto :failed

ssh.exe -i "%MS_MCP_REMOTE_SSH_KEY%" -o IdentitiesOnly=yes -o BatchMode=yes "%MS_MCP_REMOTE_SSH_TARGET%" "echo SSH_OK"
if errorlevel 1 goto :failed

echo SUCCESS: SSH monitoring is ready. Restart the Dashboard.
pause
exit /b 0

:failed
echo FAILED: SSH setup did not complete. Review the message above.
pause
exit /b 1
