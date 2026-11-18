# ⚡ LLM API Monitor

大模型 API 实时监测器 —— 一个桌面端（Electron）工具，用于监控主流大模型 API 的可用性、实时延迟、密钥有效性与账户余额。

![tech](https://img.shields.io/badge/Electron-33-47848F) ![react](https://img.shields.io/badge/React-18-61DAFB) ![ts](https://img.shields.io/badge/TypeScript-5-3178C6)

## 功能

- **实时监测**：按可配置间隔（5/10/30/60 秒）轮询各厂商 API，发送最小请求（max_tokens=5）测量真实往返延迟
- **多协议支持**：OpenAI 兼容协议、Anthropic Messages API、Google Gemini API
- **内置 21 家厂商**：OpenAI / Claude / Gemini / Groq / xAI (Grok) / DeepSeek / Kimi (月之暗面) / 通义千问 / 智谱 GLM / 百川 / MiniMax / 零一万物 / SiliconFlow / 讯飞星火 / 阶跃星辰 / 豆包 (火山引擎) / Mistral / Together / Perplexity / OpenRouter / 小米 MiMo
- **自定义供应商**：支持添加任意兼容接口（名称 / 地址 / 协议 / 余额接口 / 模型列表）
- **密钥智能识别**：批量粘贴或文件导入（JSON/CSV），密钥自动实测归属厂商；无法识别时弹窗手动分配
- **余额查询**：DeepSeek、Kimi（按官方文档对接）、SiliconFlow 等支持余额接口的厂商
- **数据持久化**：密钥与自定义供应商通过 electron-store 落盘，重启不丢失
- **告警通知**：掉线 / 余额不足弹系统通知（可开关、可静音、可关恢复提醒），60 秒冷却防轰炸
- **延迟迷你曲线**：每个密钥格子显示最近 30 次探测延迟走势
- **系统托盘 + 后台驻留**：关窗不退出，监测继续，托盘一键唤出（可关）
- **状态快照导出**：一键导出所有密钥状态为 CSV（带 BOM，Excel 直接打开不乱码）
- **应用内使用说明**：设置 → 使用说明，含快速上手三步、界面说明与常见问题
- **低资源占用**：禁用 GPU 加速 + V8 堆上限 + 隐藏时主动 GC，前台 ~156 MB / 后台 ~148 MB

## 界面

四个标签页：

| 页面 | 说明 |
|------|------|
| 仪表盘 | 全部供应商的实时状态卡片（在线/延迟/余额/认证），按国际/国内/聚合分组 |
| 密钥管理 | 批量粘贴导入、文件导入、密钥芯片管理、未识别密钥弹窗分配 |
| 供应商 | 内置供应商展示 + 自定义供应商增删改查（完整字段表单） |
| 设置 | 常规 / 外观 / 监测 / 延迟 / 使用说明 / 关于，含告警通知、托盘后台与 CSV 导出开关 |

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

## 更新日志

### v1.2.3

- 新增：仪表盘顶栏的检测间隔下拉同样支持自定义（秒数自填 + 5 分钟 / 30 分钟预设），不用再进设置页
- 优化：两处间隔控件行为一致，改完立即生效并保存

### v1.2.2

- 新增：检测间隔支持自定义（秒数自填，1 秒 ~ 24 小时），并新增 5 分钟 / 30 分钟预设
- 优化：间隔提示说明按 token 计费厂商（如月之暗面）建议更长间隔省费用

### v1.2.1

- 新增：应用内使用说明（设置 → 使用说明）：快速上手三步、界面说明、常见问题

### v1.2.0

- 新增：掉线 / 余额不足系统通知（可开关、可静音、可关恢复提醒，60 秒冷却）
- 新增：每密钥最近 30 次延迟迷你曲线
- 新增：系统托盘 + 关窗驻留后台（托盘唤出 / 退出，可关）
- 新增：一键导出状态快照 CSV（Excel 兼容，带 BOM）
- 优化：检测队列去重，同一厂商不再重复排队浪费探测
- 优化：旧版升级后新设置项自动补默认值（getSettings 浅合并）
- 优化：`monitor:getStatuses` 不再携带 balanceInfo.raw（与推送路径一致）

### v1.1.0

- MiMo Cookie 登录与配额显示、钱包接口修复、控制台链接修复、applyBalance 守卫

## License

MIT
