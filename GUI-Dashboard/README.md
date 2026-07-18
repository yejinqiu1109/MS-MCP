# MS-MCP GUI Dashboard

The Dashboard is a loopback-only local view of the configured MS-MCP workspace. It shows the active session, GUI-loop heartbeat, queues, current document, calculation folders, structure preview, and optional remote Gateway job status.

## Start

Run `Configure-MS-MCP.bat` from the repository root first, then run `Start-MS-MCP-Dashboard.bat`. The browser opens `http://127.0.0.1:4877/` unless a different port was configured.

For development from a terminal, load `config\ms-mcp.local.bat` into the current `cmd.exe` session and run `npm run dashboard`.

## Security

The Dashboard listens on loopback. Writes are disabled unless `MS_MCP_DASHBOARD_WRITE=1`; write mode also requires `MS_MCP_DASHBOARD_TOKEN` with at least 24 characters. Do not commit this token.

## Remote CASTEP monitor

Remote monitoring is optional and needs all of the following local variables:

- `MS_MCP_REMOTE_SSH_TARGET=user@host`
- `MS_MCP_REMOTE_SSH_KEY=C:\path\to\private_key`
- `MS_MCP_REMOTE_JOBS_ROOT=/absolute/path/to/Gateway/jobs`

Enter the target and jobs root through `Configure-MS-MCP.bat`, then run `Setup-Dashboard-SSH.bat`. The setup creates or reuses a dedicated key, installs the public key after one password prompt, and verifies batch login. The Dashboard never stores the remote password.

Gateway creation, queue selection, licensing, and compute resources remain Materials Studio/cluster administration tasks; the Dashboard only observes the configured jobs directory.

## Path changes

After moving the repository, workspace, Node.js, or remote account, re-run `Configure-MS-MCP.bat`. If Dashboard autostart was installed, run `Install-Dashboard-Autostart.bat` again so the Startup shortcut points to the new repository path.

