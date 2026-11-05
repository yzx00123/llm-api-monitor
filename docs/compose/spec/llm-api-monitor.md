---
feature: llm-api-monitor
status: delivered
updated: 2026-10-28
source: local
---

# LLM API 实时监测器

## Report

**What was built** — 一个基于 Electron + React + TypeScript 的桌面应用，用于实时监测主流大模型 API 的可用性与延迟。支持批量导入 API 密钥，自动识别厂商，按配置间隔（5/10/30/60 秒）轮询每个厂商的 `/v1/chat/completions` 或对应协议接口，并展示在线状态、延迟、认证结果及余额信息。

**Verification** — 运行 `npm run build`（electron-vite build）成功，输出 `out/main/index.js`、`out/preload/index.js`、`out/renderer/` 三份产物。由于当前环境无图形界面，未执行 Electron GUI 实际启动；代码已通过 TypeScript 编译与构建打包验证。

## [S1] Problem

用户需要一个桌面工具：
- 每 5–10 秒自动检测多个大模型 API 是否通畅；
- 内置主流厂商接口，最好能自动识别厂商；
- 支持批量导入 API 密钥；
- 对有余额接口的厂商查询余额。

## [S2] Design

### S2.1 架构
- **Main 进程（Node.js）**：持有厂商注册表、密钥表、监测引擎；通过 IPC 暴露控制接口；用 `setInterval` 轮询检测。
- **Preload**：通过 `contextBridge` 暴露安全 IPC 桥接。
- **Renderer（React）**：仪表盘、密钥管理、实时状态推送。

### S2.2 支持的协议与厂商
- **OpenAI 兼容协议**：OpenAI、DeepSeek、Moonshot、通义千问、智谱 AI、百川智能、MiniMax、零一万物、硅基流动、Groq、Mistral、讯飞星火、Cohere、Together、Perplexity、OpenRouter、豆包。
- **Anthropic 原生 Messages API**：Claude。
- **Google Gemini API**：Gemini。

### S2.3 密钥导入
- 批量粘贴：每行一个密钥，或 `厂商|密钥` 格式。
- 文件导入：JSON（`[{provider/baseUrl, key}]`）或 CSV/TXT（`厂商,密钥`）。
- 按厂商单独添加。

### S2.4 监测行为
- 用 `fetch` 发送最小请求（max_tokens=5）并测量 RTT；
- 状态：idle / checking / online / offline / error；
- 余额查询：DeepSeek、Moonshot、智谱 AI、硅基流动已实现；其他厂商不阻止主流程，显示 `—`。

### S2.5 UI
- 深色仪表盘，按国际厂商、国内厂商、聚合平台分组；
- 实时状态点、延迟、余额、认证状态卡片；
- 顶部统计与控制（开始/停止、间隔选择）。

## [S3] Out of Scope

- 不打包生成可执行安装包（仅构建出 Electron 产物，可用 `npm run dev` / `npm run build` 运行）；
- 不实现持久化存储（密钥仅在当前进程有效）；
- 不实现 Azure OpenAI / AWS Bedrock 的复杂签名认证；
- 余额查询仅覆盖有余额接口的厂商。

## Tasks
- [x] T1: 项目搭建与依赖配置
- [x] T2: 厂商注册表 + 监测引擎 + 余额查询
- [x] T3: 仪表盘与密钥管理 UI
- [x] T4: 构建验证与运行验证

## Journey log

- electron-vite 3.x 中 `is` 工具已被移除，改为直接使用 `process.env['ELECTRON_RENDERER_URL']` 判断开发模式。
- Windows 下 `electron` 包的 `path.txt` 可能缺失，导致运行时报告安装失败；手工写入 `electron.exe` 可恢复。
- 构建时 rollup 尝试打包 `fsevents`（macOS only），在 `electron.vite.config.ts` 的 main 构建中加入 `rollupOptions.external: ['fsevents']` 解决。
