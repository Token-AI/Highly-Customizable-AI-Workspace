# AI Code

基于 Electron、TypeScript 和原生 DOM/CSS 的 ChatGPT 订阅桌面智能体客户端。采用 VS Code 同类桌面架构：Electron 主进程中的 Node.js 负责窗口、文件和 Codex 子进程，通过受限的 preload IPC 与 Chromium 渲染进程中的 HTML/CSS/TypeScript 界面通信。本项目不是 VS Code 源码分支，也不提供 VS Code 扩展兼容能力。

迁移验证成功后，原 C++ 版本已移除；当前工程仅保留 Electron 实现。

客户端通过 ChatGPT 账号使用订阅包含的 **Codex 额度**，无需 API key；这与 ChatGPT 网页版所有功能或通用消息额度并不等同。是否可用及额度上限以账号套餐和服务端状态为准。

## 开发环境

- Windows 10/11、VS Code、Node.js 22.12 或更新版本。
- 本机已有 Node.js 26.4.0 与 npm 11.18.0。
- Electron 44.3.0、TypeScript 和开发工具均通过项目依赖管理，不需要全局安装。
- 编译使用锁定的 TypeScript 7.0.2；编辑器使用 VS Code 自带的 TypeScript 语言服务。
- 官方 `codex.exe` 作为独立子进程运行，本机已有可用安装。

首次安装依赖：

```powershell
.\scripts\install.ps1
```

该脚本只安装到项目 `node_modules`；npm 和 Electron 下载缓存分别位于 `build/npm-cache`、`build/electron-cache`，不修改全局 PATH 或 npm 配置。

如果官方 Electron 运行时下载过慢，可先执行 `npm ci --ignore-scripts --cache build/npm-cache`，再运行 `node scripts/download_electron.mjs`。备用脚本仅从 Electron 官方 GitHub release 下载，验证每段范围和完整 SHA256 后调用官方安装程序；支持重用已完成的分片。

## 构建、运行和调试

```powershell
npm run build
npm test
npm start
```

也可以运行 `.\build.ps1 -Test` 和 `.\run.ps1`。在 VS Code 中直接打开项目文件夹后，**Ctrl+Shift+B** 编译，**F5** 启动 Electron 主进程调试。预览界面使用 `npm run preview` 或 `.\run.ps1 -Preview`。

构建过程将主进程和 preload 编译为 CommonJS，将渲染进程编译为浏览器 ES modules，并复制 HTML/CSS 到 `dist/renderer`。不使用 React、webpack 或其他打包框架。构建和运行脚本不会自动结束已有程序。

## 使用界面

界面采用浅色主题和自定义标题栏，图标统一使用 VS Code 风格的本地 SVG 细线单色图标，无图标库依赖。左侧会话列表与项目目录可独立折叠，右侧为聊天区域；用户消息靠右，AI 回复靠左。每个根目录作为并列分区显示自己的名称，项目没有目录时隐藏目录区域。确认、审批、提示和项目文件选择使用统一的界面样式。

标题栏右侧采用头像与窗口控件并列的布局。点击头像可选择本地 PNG/JPEG 图片（最大 5 MiB），图片居中裁剪为 128×128，并同步到侧栏。头像按账号保存；账号未提供邮箱时，仅在当前登录期间保留。

默认启动时不打开任何项目目录，也不会自动恢复之前的项目。输入区底部的项目选择器支持搜索、新建项目、管理目录和“不在项目中工作”。同一项目可以包含最多 16 个目录，目录分别保留读取边界；命令默认在第一个目录执行。选择项目后可以浏览文件并读取预览，聊天支持只读模式和项目智能体模式。

空闲时 **Ctrl+Enter** 发送、**Enter** 换行；**Ctrl+N** 新建会话。回复生成期间可以继续输入：

- **Enter** 用消息引导当前回复。
- **Alt+Enter** 添加到消息队列。
- **Ctrl+Enter** 停止当前回复并发送新消息。
- **Shift+Enter** 换行。

当前回复正常完成后，队列按顺序发送；停止或失败后暂停，需要点击“继续队列”手动恢复。切换项目、新建会话、退出账号或重连时，尚未发送的队列会取消。

生成菜单中的 **Ask in Side Chat** 将草稿交给独立窗口，沿用当前模型和项目目录，以只读模式开始并行对话，不打断主回复。每个父窗口最多打开 4 个侧边聊天窗口；交接完成后，关闭主窗口也不会结束已经独立运行的侧边聊天。交接失败时原草稿保留。

登录在应用内置的自定义窗口中完成，外观参考 VS Code GitLab 登录面板的居中白色表单风格。官方 OpenAI 页面应用浅色外观，实际表单和认证流程仍由官方页面提供；第三方身份提供商页面保留原有样式。

需要独立 POST 认证弹窗的登录方式当前会提示使用邮箱登录，第三方身份提供商尚未全部验证兼容。

远端登录页面由独立 WebContentsView 承载，不接触应用 preload。登录状态与 Codex 会话使用应用独立的数据目录，不修改已有 Codex 应用的状态。登录、模型列表、额度和对话均由官方 Codex App Server 提供。

## 验证与打包

`npm test` 编译并运行纯 Node 测试，包括主进程逻辑和可独立测试的渲染进程逻辑，不需要登录或请求模型回复。

```powershell
npm run smoke
npm run smoke:ui
npm run package
```

`smoke` 用独立临时目录检查真实 Codex CLI 协议连通性及空会话操作，不发送模型请求；`smoke:ui` 运行 Electron 离线界面自检。另有可选 `--auth-smoke` 参数用于联网检查官方登录页面加载，它不属于默认测试，也不验证完整 OAuth 登录。完整账号登录和实际回复需要用户完成登录后验证。

Windows 打包目录输出到 `build/packages/AI Code-win32-x64`，包含可直接运行的 `ai-code.exe` 和 Electron 运行文件。打包默认不覆盖已有同名输出目录。

已有构建需要保留时，可先编译，再运行 `node scripts/package.mjs --out build/packages/workspace_client`，新包输出到该目录下的 `AI Code-win32-x64`。`--out` 仅接受项目 `build/packages` 内的路径；该命令直接使用当前 `dist`，不会重复编译或结束正在运行的旧版本。

验证流程包含 TypeScript 构建、Node 单元测试、Electron 离线界面自检、官方登录页面加载与浅色主题验证，以及 Windows 打包和 `app.asar` 内容检查。完整 OAuth 登录和实际模型回复仍需用户登录后验证。

## 工程结构

工程中的自定义文件名、类型、变量和函数统一使用 `snake_case`；Electron、DOM、Node.js 和官方协议的接口名称保持原样。函数使用 Doxygen 风格注释，说明 `@brief`、参数 `@param` 和返回值 `@returns`；PowerShell 工具使用对应的块注释。

```text
electron/               Electron 主进程、preload、协议与文件功能
electron/tests/         主进程纯 Node 测试
renderer/               原生 DOM、HTML、CSS 与界面逻辑
shared/                 主进程与界面共用的 TypeScript 类型
scripts/                安装、编译、测试、运行与打包工具
.vscode/                VS Code 构建和 Electron 调试配置
dist/                   编译后的应用
build/                  下载缓存、检查输出与打包目录
```

协议参考：[Codex App Server 官方文档](https://learn.chatgpt.com/docs/app-server)。本项目为自建客户端，与 OpenAI 官方客户端无隶属关系。
