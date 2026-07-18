# MS-MCP 安装与配置指南（Windows）

本指南按“安装前检查 → 生成配置 → 安装依赖 → 验证 → 接入 Codex → 可选组件”的顺序执行。不要跳过路径验证。

## 1. 安装前准备

### 1.1 Materials Studio

确认 Materials Studio 与 MaterialsScript 已安装。真正需要填写的是“版本根目录”，其下面应存在：

```text
<Materials Studio 根目录>\etc\Scripting\bin\RunMatScript.bat
```

例如可能是：

```text
C:\Program Files\BIOVIA\Materials Studio 2024
E:\Applications\BIOVIA\Materials Studio 2023
```

不要照抄示例；不同版本和安装盘符会变化。

### 1.2 Node.js

安装 Node.js 20+。在命令提示符中验证：

```bat
node --version
npm --version
```

配置程序要求 `node.exe` 同目录存在 `npm.cmd`。便携版也支持，但两者必须配套。

### 1.3 固定仓库位置

建议放在不含临时清理策略的固定目录，例如：

```text
C:\Tools\MS-MCP
```

工作区不要放进 Git 仓库；建议使用另一个目录，例如 `C:\MS-MCP-Workspace`。工作区会包含结构、脚本、状态、队列和计算输出，必须可写且有足够空间。

## 2. 分步生成本机配置

双击根目录的 `Configure-MS-MCP.bat`。各步骤含义如下：

1. **Node.js executable**：选择真实 `node.exe`，不能填目录。
2. **Materials Studio install root**：选择包含 `etc\Scripting` 的目录。
3. **Writable workspace**：独立的可写工作区。
4. **Structure policy**：`auto` 自动优先开放 CIF；`manual` 手工结构；`require_cif_first` 强制先找 CIF。
5. **Dashboard port**：默认 `4877`，冲突时改为未占用的 1–65535 端口。
6. **Model folder**：可选，只在 Chapter 3 模型同步功能中使用。
7. **Remote SSH target**：可选，格式 `user@host`，不使用远程监控时直接回车。
8. **Remote jobs folder**：可选，Linux 上 Materials Studio Gateway 作业目录的绝对路径。

程序会验证 Node、npm、`RunMatScript.bat`、端口和策略，并创建工作区。成功后生成：

```text
config\ms-mcp.local.bat
config\codex-ms-mcp.local.toml
```

这两个是本机文件，不应上传或发送给他人。

无人值守/测试环境可使用参数：

```bat
Configure-MS-MCP.bat -NonInteractive -NodePath "C:\Program Files\nodejs\node.exe" -MaterialsStudioRoot "C:\Program Files\BIOVIA\Materials Studio 2024" -WorkRoot "C:\MS-MCP-Workspace"
```

## 3. 安装锁定依赖

运行 `Install-MS-MCP.bat`。它执行 `npm ci`，严格按照 `package-lock.json` 安装，并运行仓库完整性与 JavaScript 语法检查。

若公司网络阻止 npm，请通过组织批准的 npm registry/proxy 安装；不要从不可信压缩包复制 `node_modules`。GitHub 发布包本身不包含 `node_modules`。

## 4. 验证安装

运行 `Test-MS-MCP.bat`。成功信息应包括：

- 发布文件和 JavaScript 语法通过；
- `installRootExists` 和 `runMatScriptExists` 为 `true`；
- 安全默认值测试通过；
- MCP stdio 初始化、工具列举和状态调用通过。

如果失败，从输出中的第一条错误开始修正，不要只看最后的 `FAILED`。

## 5. 接入 Codex

1. 打开 `config\codex-ms-mcp.local.toml`。
2. 打开 `%USERPROFILE%\.codex\config.toml`。
3. 若已有 `[mcp_servers.MS-MCP]`，先备份并替换旧块；不要重复保留两个同名块。
4. 合并生成的全部内容并保存。
5. 完全退出 Codex 后重新打开。
6. 在 MCP 列表中确认 MS-MCP，并调用 `ms_status` 检查路径。

其他 MCP 客户端可参考 `.mcp.example.json`，重点是 `command` 指向 Node、`args` 指向本仓库 `src\index.js`，并传入相同环境变量。

## 6. 安装后需要修改路径的场景

### 仓库移动或改名

必须重新运行 `Configure-MS-MCP.bat`，并用新 TOML 替换 Codex 中旧块。原因是 MCP `args` 和 `cwd` 都含仓库绝对路径。若已安装 Dashboard 自启，再运行一次 `Install-Dashboard-Autostart.bat` 更新快捷方式。

### Node.js 升级或迁移

重新配置，确认 `NODE_EXE`、`NPM_CMD` 和 Codex 的 `command` 都指向同一套 Node。然后再次运行安装与测试 BAT。

### Materials Studio 升级

重新配置 `MS_INSTALL_ROOT`。不要只改版本号；先确认新目录中的 `RunMatScript.bat` 存在，再跑完整测试。MaterialsScript API 的版本差异还需要用小型授权模型验证。

### 工作区迁移

先退出 Codex、Dashboard 和 GUI loop，再复制旧工作区。重新配置新 `MS_MCP_WORK_ROOT`，确认 `.ms-mcp-session.json` 中旧的绝对 session 路径是否仍有效；若无效，备份后删除该 session 指针，让 MS-MCP 创建新会话。不要把工作区复制进仓库后上传。

### 远程服务器或用户名变化

重新配置 `MS_MCP_REMOTE_SSH_TARGET`、`MS_MCP_REMOTE_JOBS_ROOT`，必要时修改 `MS_MCP_REMOTE_SSH_KEY`。然后运行 `Setup-Dashboard-SSH.bat` 安装/验证新目标的公钥。旧服务器的 `authorized_keys` 需要由服务器管理员按策略移除旧公钥。

## 7. 可选 Dashboard 与自启

运行 `Start-MS-MCP-Dashboard.bat` 后访问 `http://127.0.0.1:<端口>/`。若要开机登录后启动，运行 `Install-Dashboard-Autostart.bat`。

Dashboard 默认只读。若需要写操作，应手工在本机配置中设置：

```bat
set "MS_MCP_DASHBOARD_WRITE=1"
set "MS_MCP_DASHBOARD_TOKEN=<至少24字符的随机令牌>"
```

令牌不要写进 Git 跟踪文件。重新运行配置会覆盖 `ms-mcp.local.bat`，因此自定义安全值需在重配后复核。

## 8. 可选 GUI loop

配置文件已经设置 `MS_MCP_QUEUE_DIR=%MS_MCP_WORK_ROOT%\.mcp-queue`。从 Materials Studio GUI 运行 `materialscript\mcp_loop_gui.pl`，让脚本获得当前项目上下文。`materialscript\start_mcp_loop.bat` 会加载同一配置并验证 `RunMatScript.bat`，但独立脚本运行环境不等价于当前 GUI 项目。

## 9. 卸载

1. 从 Codex `config.toml` 删除 `[mcp_servers.MS-MCP]` 及其 env 块。
2. 删除 Windows Startup 文件夹中的 `MS-MCP Dashboard.lnk`（如已安装）。
3. 确认不再需要后删除仓库目录。
4. 工作区可能包含研究数据和计算结果，不随程序目录自动删除；备份后再手工处理。
5. 如配置过 SSH，从远端 `authorized_keys` 移除对应公钥，并删除本地专用 key（只有在确认不再被其他用途引用后）。

## 10. 故障定位速查

| 现象 | 检查 |
|---|---|
| `Node.js was not found` | `NODE_EXE` 是否是文件；是否移动/升级 Node |
| `npm.cmd was not found` | 是否安装完整 Node；Node 与 npm 是否同目录 |
| `RunMatScript.bat was not found` | `MS_INSTALL_ROOT` 是否指向具体 Materials Studio 版本根目录 |
| Codex 显示 MCP 启动失败 | TOML 是否重复；`command`、`args`、`cwd` 是否仍存在；反斜杠是否正确转义 |
| 工具超时 | Materials Studio 许可证、弹窗、计算时间及 `tool_timeout_sec` |
| Dashboard 端口占用 | 重新配置其他端口，并同步 Codex env |
| SSH 监控失败 | Windows OpenSSH、私钥路径、`user@host`、远端权限、jobs root |
| GUI 队列不动 | GUI loop 是否在正确项目中运行；`.mcp-queue\stop` 是否存在；heartbeat 是否过期 |

