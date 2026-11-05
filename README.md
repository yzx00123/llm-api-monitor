# ⚡ LLM API Monitor

大模型 API 实时监测器 —— 一个桌面端（Electron）工具，用于监控主流大模型 API 的可用性、实时延迟、密钥有效性与账户余额。

![tech](https://img.shields.io/badge/Electron-33-47848F) ![react](https://img.shields.io/badge/React-18-61DAFB) ![ts](https://img.shields.io/badge/TypeScript-5-3178C6)

## 功能

- **实时监测**：按可配置间隔（5/10/30/60 秒）轮询各厂商 API，发送最小请求（max_tokens=5）测量真实往返延迟
- **多协议支持**：OpenAI 兼容协议、Anthropic Messages API、Google Gemini API
- **内置 20 家厂商**：OpenAI / Claude / Gemini / DeepSeek / Kimi (月之暗面) / 通义千问 / 智谱 GLM / 百川 / MiniMax / 零一万物 / SiliconFlow / 讯飞星火 / 阶跃星辰 / 豆包 (火山引擎) / Groq / Mistral / Cohere / Together / Perplexity / OpenRouter
- **自定义供应商**：支持添加任意兼容接口（名称 / 地址 / 协议 / 余额接口 / 模型列表）
- **密钥智能识别**：批量粘贴或文件导入（JSON/CSV），密钥自动实测归属厂商；无法识别时弹窗手动分配
- **余额查询**：DeepSeek、Kimi（按官方文档对接）、SiliconFlow 等支持余额接口的厂商
- **数据持久化**：密钥与自定义供应商通过 electron-store 落盘，重启不丢失
- **低资源占用**：禁用 GPU 加速 + V8 堆上限 + 隐藏时主动 GC，前台 ~156 MB / 后台 ~148 MB

## 界面

三个标签页：

| 页面 | 说明 |
|------|------|
| 仪表盘 | 全部供应商的实时状态卡片（在线/延迟/余额/认证），按国际/国内/聚合分组 |
| 密钥管理 | 批量粘贴导入、文件导入、密钥芯片管理、未识别密钥弹窗分配 |
| 供应商 | 内置供应商展示 + 自定义供应商增删改查（完整字段表单） |

## 运行

```bash
npm install
npm run dev      # 开发模式（热更新）
npm run build    # 构建到 out/
```

构建产物直接用 Electron 运行：

```bash
./node_modules/.bin/electron out/main/index.js
```

> Windows 下若提示 Electron 安装不完整，删除 `node_modules/electron` 后重新 `npm install`；
> 若 `ffmpeg.dll` 缺失，从 `%LOCALAPPDATA%\electron\Cache` 中的发行包重新解压补齐。

## 项目结构

```
src/
├── main/            # Electron 主进程
│   ├── index.ts     # 入口 + IPC 路由
│   ├── monitor.ts   # 监测引擎（限并发、防重入、余额查询）
│   ├── providers.ts # 内置厂商注册表
│   └── store.ts     # electron-store 持久化
├── preload/         # contextBridge 安全桥接
└── renderer/        # React 仪表盘
    └── src/components/
        ├── Dashboard.tsx        # 状态卡片网格
        ├── ProviderCard.tsx     # 单卡片（React.memo）
        ├── KeyManager.tsx       # 密钥导入/管理
        └── ProviderManager.tsx  # 自定义供应商管理
```

## 设计说明

- **密钥安全**：密钥仅存储在本地 `%APPDATA%` 的 electron-store 配置中，不经过任何第三方服务器
- **并发控制**：监测引擎最多同时 5 个探测请求，超出排队，防重入
- **每家厂商的余额接口格式不同**，解析逻辑基于实测（DeepSeek）与官方文档（Kimi）对接，其余厂商做防御性解析

## 已知限制

- 每次探测消耗极少量 token（10 tokens/次，10 秒间隔约 3600 tokens/小时）
- 部分厂商无公开余额接口（如智谱），余额显示 "—"
- Azure OpenAI / AWS Bedrock 的签名认证暂未支持

## License

MIT
