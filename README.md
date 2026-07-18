# MS-MCP

面向 Windows 与 BIOVIA Materials Studio 的外部 Model Context Protocol（MCP）服务器。它让 Codex 或其他 MCP 客户端通过官方 MaterialsScript 运行时执行建模、Forcite、DMol3、CASTEP、GUI 队列和结果读取，并提供本地 Dashboard。

> 当前版本：`0.2.0`。项目不是 BIOVIA/Dassault Systèmes 官方产品；使用前请确认 Materials Studio 许可证及 MaterialsScript 组件可用。

## 主要能力

- 检查 Materials Studio、`RunMatScript.bat`、工作区和会话状态。
- 创建/导入结构，维护当前 GUI 文档，并执行常用结构编辑。
- 执行 Forcite、DMol3、CASTEP 任务与预设工作流。
- 通过可选的 Materials Studio GUI 循环把脚本送入当前打开的项目。
- 从受限 HTTPS 白名单下载 CIF，并限制响应大小。
- 准备远程 CASTEP 任务，Dashboard 可通过 SSH 只读监控 Gateway 作业目录。
- 所有生成文件默认限制在独立工作区；任意 MaterialsScript 和外部输入默认关闭。

## 系统要求

- Windows 10/11（64 位）。
- BIOVIA Materials Studio，且已安装 MaterialsScript；必须能找到：
  `MS_INSTALL_ROOT\etc\Scripting\bin\RunMatScript.bat`。
- Node.js 20 或更高版本，包含 `npm.cmd`。
- Codex 或其他支持 stdio MCP 的客户端。
- 可选：Windows OpenSSH Client（只在远程 Dashboard 监控时使用）。

## 最快安装

下载 Release 压缩包或克隆仓库后，不要把项目放入随后会删除或改名的临时目录。推荐路径如 `C:\Tools\MS-MCP`。

1. 双击 `Configure-MS-MCP.bat`，逐项确认 Node、Materials Studio、工作区等路径。
2. 双击 `Install-MS-MCP.bat`，以 `npm ci` 安装锁定依赖并检查发布文件。
3. 双击 `Test-MS-MCP.bat`，验证路径、安全默认值和 MCP stdio 通信。
4. 打开生成的 `config\codex-ms-mcp.local.toml`，把完整内容合并到 `%USERPROFILE%\.codex\config.toml`。
5. 完全退出并重启 Codex，在 MCP 列表中确认 `MS-MCP` 可用。

完整逐步说明、路径示例和安装后修改方法见 [安装与配置指南](docs/INSTALLATION.zh-CN.md)。

## 配置 BAT 会生成什么

`Configure-MS-MCP.bat` 是唯一推荐的本机配置入口，内部调用 PowerShell 完成验证和安全写入：

- `config\ms-mcp.local.bat`：供启动、测试、Dashboard、GUI 循环和 SSH 脚本统一读取。
- `config\codex-ms-mcp.local.toml`：供复制到 Codex 的 MCP 配置块。

这两个文件包含本机绝对路径，已由 `.gitignore` 排除，不能上传 GitHub。仓库只保留不含真实机器信息的 `config\ms-mcp.example.bat`、`.mcp.example.json` 和 `codex-ms-mcp.toml.example`。

## 必须根据机器修改的路径

| 变量/配置 | 含义 | 何时必须修改 |
|---|---|---|
| `NODE_EXE` / `command` | `node.exe` 的绝对路径 | Node 安装位置变化或换电脑 |
| `NPM_CMD` | 与 Node 配套的 `npm.cmd` | Node 安装位置变化 |
| `MS_INSTALL_ROOT` | Materials Studio 安装根目录 | 版本、盘符或安装目录变化 |
| `MS_MCP_WORK_ROOT` | 可写的独立任务工作区 | 换电脑、迁移数据或调整存储盘 |
| MCP `args` | 本仓库 `src\index.js` | 仓库移动、改名或重新解压 |
| MCP `cwd` | 本仓库根目录 | 仓库移动、改名或重新解压 |
| `MS_MCP_MODEL_ROOT` | 已有 Materials Studio 模型目录 | 仅使用 Chapter 3 同步时设置 |
| `MS_MCP_REMOTE_SSH_TARGET` | `user@host` | 仅使用远程监控时设置 |
| `MS_MCP_REMOTE_SSH_KEY` | SSH 私钥绝对路径 | 使用非默认密钥或用户目录变化 |
| `MS_MCP_REMOTE_JOBS_ROOT` | Linux Gateway 作业根目录 | 远端版本、用户或 Gateway 根目录变化 |

仓库移动后不要逐个修改启动脚本；重新运行 `Configure-MS-MCP.bat`，再用新生成的 TOML 更新 Codex 即可。

## 启动方式

### MCP 服务器

正常情况下由 Codex 按 TOML 自动启动。调试时可运行：

```bat
Run-MS-MCP.bat
```

该进程使用 stdio 协议，命令窗口看似等待输入是正常现象；不要向 stdout 添加日志。

### Dashboard

双击 `Start-MS-MCP-Dashboard.bat`，浏览器打开 `http://127.0.0.1:4877/`。端口可在重新配置时修改。MCP 也可在后台启动 Dashboard，但默认不会强制打开浏览器。

需要登录 Windows 后自动启动时，先完成配置与测试，再运行 `Install-Dashboard-Autostart.bat`。快捷方式使用相对仓库定位；若移动仓库，重新安装自启快捷方式。

### Materials Studio GUI 循环

要把任务写入当前由用户打开的 Materials Studio 项目时：

1. 先运行 `Configure-MS-MCP.bat`。
2. 在 Materials Studio 中打开目标项目。
3. 从 Materials Studio 的脚本界面运行 `materialscript\mcp_loop_gui.pl`；或在正确的 Materials Studio 会话条件下使用 `materialscript\start_mcp_loop.bat`。
4. 队列位于 `%MS_MCP_WORK_ROOT%\.mcp-queue`，停止标记为 `.mcp-queue\stop`。

GUI 循环必须在 Materials Studio GUI 环境中运行，不能把普通 `RunMatScript.bat` 进程误当成已打开项目的 GUI 上下文。

### 远程 CASTEP Dashboard 监控（可选）

重新运行 `Configure-MS-MCP.bat`，填写 `user@host` 和远程 Gateway jobs 路径，然后运行 `Setup-Dashboard-SSH.bat`。脚本创建独立 Ed25519 密钥、把公钥加入远端 `authorized_keys`，并验证非交互登录。Dashboard 不保存服务器密码。

这只配置作业目录监控；Materials Studio Gateway、队列、许可证和计算核数仍需在 Materials Studio Job Control 中按实际服务器配置。

## 安全默认值

- `MS_MCP_ALLOW_ARBITRARY_SCRIPT=0`：禁用任意 MaterialsScript。
- `MS_MCP_ALLOW_GUI_QUEUE=1`：允许结构化 GUI 队列工具。
- `MS_MCP_ALLOW_EXTERNAL_INPUTS=0`：禁止读取工作区外输入。
- CIF 仅允许配置的 HTTPS 主机，默认最大 10 MiB。
- Dashboard 默认只监听 `127.0.0.1`；写操作默认关闭。启用写操作时必须配置至少 24 字符令牌。
- 工作区路径经边界与 junction/symlink 检查，防止任务越界写入。

更详细的部署原则见 [LOCAL-HARDENING.md](LOCAL-HARDENING.md)，漏洞报告见 [SECURITY.md](SECURITY.md)。

## 开发与验证

在已经加载正确环境变量的终端中：

```powershell
npm ci
npm run check
npm run smoke
npm run security-smoke
npm run mcp-smoke
```

Windows 用户直接运行 `Test-MS-MCP.bat` 更简单，它会加载生成的本机配置。涉及真实 Forcite/DMol3/CASTEP 的计算仍应在授权的测试模型和服务器上单独验证。

## 仓库结构

```text
MS-MCP/
├─ src/                         MCP 服务器与 MaterialsScript 生成逻辑
├─ materialscript/              Materials Studio GUI 循环
├─ GUI-Dashboard/               本地 Dashboard
├─ scripts/                     验证、解析、同步与远程准备脚本
├─ config/                      示例配置；本机生成配置不会上传
├─ docs/                        安装与配置文档
├─ examples/                    示例输入
├─ Configure-MS-MCP.bat         分步配置入口
├─ Install-MS-MCP.bat           锁定依赖安装
├─ Test-MS-MCP.bat              完整本机验证
└─ Run-MS-MCP.bat               手动 stdio 启动入口
```

GitHub 上传清单与排除项见 [RELEASE-FILES.md](RELEASE-FILES.md)。

## 常见问题

**找不到 `RunMatScript.bat`**：`MS_INSTALL_ROOT` 填得太上层或太下层。应直接指向包含 `etc\Scripting` 的 Materials Studio 版本目录，然后重新配置。

**移动仓库后 Codex 启动失败**：重新运行配置 BAT，并替换 Codex TOML 中旧的 `command`、`args`、`cwd` 与环境路径。

**Node 可用但 `npm.cmd` 不存在**：安装完整的 Node.js Windows 发行版，而不是只复制 `node.exe`。

**Dashboard 可打开但没有结构/作业**：先检查工作区与当前 session；远程作业还需要 SSH target、key 和 jobs root 三项同时有效。

**MCP 修改不到当前 GUI 项目**：确认 GUI 循环是在目标 Materials Studio 会话中运行，而不是只启动了独立 MaterialsScript 进程。

## 贡献与许可

提交 Issue/PR 前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，不要提交许可证文件、真实结构数据、服务器地址、私钥、本机配置或计算输出。项目采用 [MIT License](LICENSE)。

## 致谢与视频教程

- 本项目初始代码基于 [shenghhe-svg/shengh_he](https://github.com/shenghhe-svg/shengh_he)，感谢原作者的工作与分享。
- 安装、配置及使用视频教程可在抖音搜索：抖音号 `Au.Tom`，昵称 `Dr.小叶`。

独立的上游来源与教程声明见 [NOTICE.md](NOTICE.md)。
