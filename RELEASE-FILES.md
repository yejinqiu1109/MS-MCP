# GitHub release file manifest

Upload the repository contents represented by this manifest. The release ZIP is built from the same allowlist.

## Include

- Root metadata/docs: `.gitignore`, `.gitattributes`, `.npmignore`, `.mcp.json`, `.mcp.example.json`, `.codex-plugin/`, `LICENSE`, `NOTICE.md`, `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `LOCAL-HARDENING.md`, `RELEASE-FILES.md`.
- Node package: `package.json`, `package-lock.json`, `src/`, `scripts/`.
- Windows setup/launchers: `Configure-MS-MCP.bat`, `Install-MS-MCP.bat`, `Test-MS-MCP.bat`, `Run-MS-MCP.bat`, `Start-MS-MCP-Dashboard.bat`, `Start-MS-MCP-Dashboard-Background.vbs`, `Install-Dashboard-Autostart.bat`, `Install-Dashboard-Autostart.ps1`, `Setup-Dashboard-SSH.bat`.
- Product assets: `GUI-Dashboard/`, `materialscript/`, `examples/`, `docs/`, `config/ms-mcp.example.bat`, `.mcp.example.json`, `codex-ms-mcp.toml.example`.

## Exclude

- `node_modules/`, `workspace/`, `MS-MCP-Workspace/`, `*.log`, `*.pid`, `*.tgz`, `*.zip`.
- `config/ms-mcp.local.bat`, `config/codex-ms-mcp.local.toml`, `.env`.
- Materials Studio generated `.xsd`, `.out`, `*MatStudioLog.htm`, numbered run folders, project files, calculations and queues.
- SSH keys, passwords, tokens, server addresses, license files, unpublished structures and research outputs.

Before tagging a release, run `Test-MS-MCP.bat`, build the allowlisted ZIP, extract it to a new path, run `Configure-MS-MCP.bat`, and repeat the tests from the extracted copy.
