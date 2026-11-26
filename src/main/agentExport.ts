import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { parseDocument } from 'yaml'

/**
 * 「导出到 Agent」的目标定义、检测与写入。
 *
 * 原来这些逻辑散在 index.ts 里，有两个实际问题：
 *   1. 检测只看「配置文件存不存在」。而我们自己导出过就会把文件建出来，
 *      于是点过导出之后每家都显示「已安装」—— 用户明明没装 Claude Code。
 *   2. 有几种写入格式是猜的（比如 DSH 根本没有 ~/.deepseek-harness/config.json，
 *      它真正的 provider 配置在 ~/.dsh/profiles/<profile>/cordis.patch.yml）。
 *
 * 现在：检测靠「真实安装证据」（命令行、安装目录），配置文件只作为「已有配置」
 * 的附加信息；写入前先渲染完整结果给用户预览，写完再回读校验一遍。
 */

export type AgentTargetId =
  | 'claudeCode'
  | 'cursorUser'
  | 'codex'
  | 'gemini'
  | 'openCode'
  | 'mimoDesktop'
  | 'openclaw'
  | 'deepseekHarness'
  | 'kimiCode'
  | 'minimaxCode'
  | 'codebuddy'
  | 'workbuddy'
  | 'baiduComate'
  | 'byteTrae'
  | 'aliQoder'
  | 'aliLingma'
  | 'doubao'
  | 'marscode'
  | 'coze'
  | 'custom'

export interface AgentTargetSpec {
  id: AgentTargetId
  label: string
  /** 国际 / 国内，只用于界面分组 */
  group: '国际' | '国内'
  /** 配置文件路径，`~` 开头（相对用户目录），支持 %APPDATA% 这类占位符 */
  path: string
  /** 文件该怎么合并 */
  format: 'json' | 'jsonc' | 'toml' | 'yaml' | 'env' | 'manual'
  /** 改的是文件里哪一块（界面上展示，避免用户以为「一键就完事」） */
  writes: string
  /** 安装证据：命令行名，在 PATH 和 %APPDATA%\npm 里找 */
  bins?: string[]
  /** 安装证据：目录（存在即认为装了） */
  dirs?: string[]
  /** 该 Agent 的特殊说明 */
  note?: string
  /** 这个 Agent 只认哪种协议的端点；不填按 openai 处理 */
  protocol?: 'openai' | 'anthropic' | 'gemini' | 'any'
  /**
   * 这条通道的可信度（不填按 guessed 处理）：
   * - verified：在本机真实配置里见过同样结构（MiMo Desktop / DSH / OpenClaw）
   * - documented：官方文档给的配置位置与字段（Claude Code / Codex / Gemini / OpenCode）
   * - guessed：按厂商习惯推测的路径与字段，产品是否读它未经验证
   */
  confidence?: 'verified' | 'documented' | 'guessed'
}

export const AGENT_TARGETS: AgentTargetSpec[] = [
  {
    id: 'claudeCode',
    label: 'Claude Code',
    group: '国际',
    path: '~/.claude/settings.json',
    format: 'json',
    writes: 'settings.json 的 env.ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL（需要 Anthropic 兼容端点）',
    protocol: 'anthropic',
    bins: ['claude'],
    dirs: ['~/.claude/projects', '~/.local/bin/claude.exe', 'AppData/Roaming/npm/node_modules/@anthropic-ai'],
  },
  {
    id: 'codex',
    label: 'OpenAI Codex CLI',
    group: '国际',
    path: '~/.codex/config.toml',
    format: 'toml',
    writes: '[providers.llm-monitor] 一段（只替换本工具写的那段）',
    bins: ['codex'],
    dirs: ['~/.codex/sessions', 'AppData/Roaming/npm/node_modules/@openai/codex'],
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    group: '国际',
    path: '~/.gemini/settings.json',
    format: 'json',
    writes: 'settings.json 的 env.GEMINI_API_KEY / GOOGLE_GEMINI_BASE_URL（需要 Gemini 协议端点）',
    protocol: 'gemini',
    bins: ['gemini'],
    dirs: ['~/.gemini/tmp', 'AppData/Roaming/npm/node_modules/@google/gemini-cli'],
  },
  {
    id: 'openCode',
    label: 'OpenCode',
    group: '国际',
    path: '~/.config/opencode/opencode.json',
    format: 'json',
    writes: 'provider.llm-monitor（@ai-sdk/openai-compatible）',
    bins: ['opencode'],
    dirs: ['~/.local/share/opencode', 'AppData/Roaming/npm/node_modules/opencode-ai'],
  },
  {
    id: 'cursorUser',
    label: 'Cursor',
    group: '国际',
    path: '~/.cursor/mcp.json',
    format: 'manual',
    protocol: 'any',
    writes: 'Cursor 没有「自定义 Base URL」的配置文件，只能在设置界面手动填',
    bins: ['cursor'],
    dirs: ['AppData/Local/Programs/cursor', 'AppData/Local/cursor-updater', 'AppData/Roaming/Cursor'],
    note: 'Cursor 的模型端点要在 设置 → Models → OpenAI API Key / Override Base URL 里手动填，这里只能帮你复制。',
  },
  {
    id: 'deepseekHarness',
    label: 'DeepSeek Harness（DSH）',
    group: '国内',
    path: '~/.dsh/profiles/desktop/cordis.patch.yml',
    format: 'yaml',
    writes: 'llm-pi-ai 的 providers.llm-monitor + .credentials.yaml 的 refs（两个文件）',
    bins: ['dsh'],
    dirs: ['~/.dsh/profiles/desktop'],
    note: 'DSH 的密钥写在 ~/.dsh/.credentials.yaml 的 refs 里，provider 写在 cordis.patch.yml，两处都会改。',
  },
  {
    id: 'mimoDesktop',
    label: '小米 MiMo Desktop',
    group: '国内',
    path: '~/.config/mimocode/mimocode.jsonc',
    format: 'jsonc',
    writes: 'provider.llm-monitor（@ai-sdk/openai-compatible）',
    bins: ['mimo', 'mimocode'],
    dirs: ['AppData/Roaming/Xiaomi MiMo', 'AppData/Local/xiaomi-mimo-desktop-updater', 'AppData/Local/Programs/Xiaomi MiMo'],
  },
  {
    id: 'openclaw',
    label: 'OpenClaw',
    group: '国内',
    path: '~/.openclaw/openclaw.json',
    format: 'json',
    writes: 'models.providers.llm-monitor（api: openai-completions）',
    bins: ['openclaw'],
    dirs: ['AppData/Roaming/npm/node_modules/openclaw', 'AppData/Local/openclaw'],
  },
  {
    id: 'kimiCode',
    label: 'Kimi CLI（月之暗面）',
    group: '国内',
    path: '~/.kimi/config.json',
    format: 'json',
    writes: 'provider.llm-monitor',
    bins: ['kimi'],
    dirs: ['AppData/Roaming/npm/node_modules/@moonshot-ai/kimi-cli', '~/.kimi/sessions'],
  },
  {
    id: 'minimaxCode',
    label: 'MiniMax Code',
    group: '国内',
    path: '~/.minimax-code/config.json',
    format: 'json',
    writes: 'provider.llm-monitor',
    bins: ['minimax'],
    dirs: ['AppData/Roaming/npm/node_modules/minimax-code', 'AppData/Local/Programs/MiniMax'],
  },
  {
    id: 'codebuddy',
    label: '腾讯 CodeBuddy',
    group: '国内',
    path: '~/.codebuddy/settings.json',
    format: 'json',
    writes: 'env.CODEBUDDY_API_KEY / BASE_URL + provider.llm-monitor',
    bins: ['codebuddy'],
    dirs: ['AppData/Local/Programs/CodeBuddy', 'AppData/Roaming/CodeBuddy'],
  },
  {
    id: 'workbuddy',
    label: '腾讯 WorkBuddy',
    group: '国内',
    path: '~/.workbuddy/config.json',
    format: 'json',
    writes: 'env + provider.llm-monitor',
    bins: ['workbuddy'],
    dirs: ['AppData/Local/Programs/WorkBuddy', 'AppData/Roaming/WorkBuddy'],
  },
  {
    id: 'baiduComate',
    label: '百度文心快码 Comate',
    group: '国内',
    path: '~/.comate/mcp.local.json',
    format: 'json',
    writes: 'provider.llm-monitor',
    dirs: ['AppData/Roaming/Comate'],
    note: 'Comate 主要作为 VS Code 插件使用，若未装插件这里会显示「未检测到」。',
  },
  {
    id: 'byteTrae',
    label: '字节 Trae',
    group: '国内',
    path: '~/.trae/config.json',
    format: 'json',
    writes: 'provider.llm-monitor',
    dirs: ['AppData/Local/Programs/Trae', 'AppData/Roaming/Trae'],
  },
  {
    id: 'aliQoder',
    label: '阿里 Qoder',
    group: '国内',
    path: '~/.qoder/config.json',
    format: 'json',
    writes: 'provider.llm-monitor',
    dirs: ['AppData/Local/Programs/Qoder', 'AppData/Roaming/Qoder'],
  },
  {
    id: 'aliLingma',
    label: '通义灵码 Lingma',
    group: '国内',
    path: '~/.lingma/config.json',
    format: 'json',
    writes: 'provider.llm-monitor',
    dirs: ['AppData/Roaming/Lingma'],
  },
  {
    id: 'doubao',
    label: '字节 豆包 Doubao',
    group: '国内',
    path: '~/.doubao/config.json',
    format: 'json',
    writes: 'env.DOUBAO_API_KEY + provider.llm-monitor',
    dirs: ['AppData/Local/Programs/Doubao', 'AppData/Roaming/Doubao'],
  },
  {
    id: 'marscode',
    label: '字节 MarsCode',
    group: '国内',
    path: '~/.marscode/config.json',
    format: 'json',
    writes: 'env + provider.llm-monitor',
    dirs: ['AppData/Local/Programs/MarsCode', 'AppData/Roaming/MarsCode'],
  },
  {
    id: 'coze',
    label: '扣子 Coze',
    group: '国内',
    path: '~/.coze/config.json',
    format: 'json',
    writes: 'provider.llm-monitor',
    dirs: ['AppData/Roaming/Coze', 'AppData/Local/Programs/Coze'],
  },
]

/** 我们写进各家配置里的固定 provider key。 */
const PROVIDER_KEY = 'llm-monitor'
/** DSH 从环境变量读密钥，这个名字对应 .credentials.yaml 里的 refs 键。 */
const DSH_ENV = 'LLM_MONITOR_API_KEY'

/**
 * 各通道可信度。写文件这件事本身都能验证（回读解析），但「那个产品到底读不读
 * 这个路径 / 这套字段」只有官方文档或本机真实配置能证明，剩下的就是推测 ——
 * 界面上必须如实标出来，不然用户会以为 19 个都能用。
 */
const CONFIDENCE: Record<string, 'verified' | 'documented' | 'guessed'> = {
  // 本机真实配置里见过同类结构
  mimoDesktop: 'verified',
  deepseekHarness: 'verified',
  openclaw: 'verified',
  // 官方文档明确写了配置文件与字段
  claudeCode: 'documented',
  codex: 'documented',
  gemini: 'documented',
  openCode: 'documented',
  cursorUser: 'documented',
  // 按厂商习惯推测的位置，产品读不读未经验证
  kimiCode: 'guessed',
  minimaxCode: 'guessed',
  codebuddy: 'guessed',
  workbuddy: 'guessed',
  baiduComate: 'guessed',
  byteTrae: 'guessed',
  aliQoder: 'guessed',
  aliLingma: 'guessed',
  doubao: 'guessed',
  marscode: 'guessed',
  coze: 'guessed',
}

/**
 * 各家的 Anthropic 兼容端点（Claude Code / Kimi CLI 这类只吃 Anthropic 协议的
 * Agent 必须用它）。这些端点都实测过：用真 key 打 /v1/messages 会回 Anthropic
 * 格式的 402/429（= 端点存在、协议对），而不是 404。
 */
const ANTHROPIC_COMPAT: Record<string, string> = {
  deepseek: 'https://api.deepseek.com/anthropic',
  moonshot: 'https://api.moonshot.cn/anthropic',
  kimi: 'https://api.moonshot.cn/anthropic',
  mimo: 'https://api.xiaomimimo.com/anthropic',
  zhipu: 'https://open.bigmodel.cn/api/anthropic',
  minimax: 'https://api.minimaxi.com/anthropic',
}

// ─────────────────────────── 路径 / 检测 ───────────────────────────

function expand(pathTemplate: string): string {
  let out = pathTemplate
  if (out.startsWith('~/') || out === '~') out = join(homedir(), out.slice(1))
  out = out.replace(/%([A-Za-z_]+)%/g, (_m, name: string) => process.env[name.toUpperCase()] ?? '')
  // 'AppData/Roaming/xxx' 这类配置里是相对用户目录写的，统一按 homedir 解析。
  if (!/^[A-Za-z]:[\\/]/.test(out) && !out.startsWith('\\\\') && !out.startsWith('/')) {
    out = join(homedir(), out)
  }
  return out
}

/** 在 PATH、%APPDATA%\npm、~/.local/bin 里找可执行文件。 */
function findBinary(name: string): string | null {
  const exts = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
  const dirs = [
    ...(process.env.PATH ?? '').split(';').filter(Boolean),
    join(process.env.APPDATA ?? expand('AppData/Roaming'), 'npm'),
    join(homedir(), '.local', 'bin'),
  ]
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = join(dir, name + ext)
      if (existsSync(file)) return file
    }
  }
  return null
}

export interface AgentTargetInfo {
  id: AgentTargetId
  label: string
  group: '国际' | '国内'
  format: AgentTargetSpec['format']
  /** 配置文件绝对路径 */
  path: string
  /** 配置文件是否已存在 */
  exists: boolean
  /** 是否找到真实安装证据 */
  installed: boolean
  /** 证据说明，例如「找到 C:\Users\jz\AppData\Roaming\Xiaomi MiMo」 */
  evidence: string | null
  writes: string
  note?: string
  /** 这条通道的可信度，界面上要如实标出来（推测的路径可能根本没人读） */
  confidence: 'verified' | 'documented' | 'guessed'
}

/** 检测所有目标：安装证据 + 配置文件存在与否，两个维度分开报。 */
export function detectAgentTargets(): AgentTargetInfo[] {
  return AGENT_TARGETS.map((spec) => {
    const path = expand(spec.path)
    let evidence: string | null = null
    for (const bin of spec.bins ?? []) {
      const found = findBinary(bin)
      if (found) {
        evidence = `命令行 ${found}`
        break
      }
    }
    if (!evidence) {
      for (const dir of spec.dirs ?? []) {
        const full = expand(dir)
        if (!existsSync(full)) continue
        evidence = `安装目录 ${full}`
        break
      }
    }
    if (!evidence) {
      // VS Code 插件类：目录名里带关键词才算装过
      const extDir = join(homedir(), '.vscode', 'extensions')
      const keyword: Record<string, string> = {
        baiduComate: 'comate',
        aliLingma: 'lingma',
      }
      const kw = keyword[spec.id]
      if (kw && existsSync(extDir)) {
        try {
          const hit = readdirSync(extDir).find((n) => n.toLowerCase().includes(kw))
          if (hit) evidence = `VS Code 扩展 ${hit}`
        } catch {
          /* 忽略：读不到就当没装 */
        }
      }
    }
    return {
      id: spec.id,
      label: spec.label,
      group: spec.group,
      format: spec.format,
      path,
      exists: existsSync(path),
      installed: evidence !== null,
      evidence,
      writes: spec.writes,
      note: spec.note,
      confidence: spec.confidence ?? CONFIDENCE[spec.id] ?? 'guessed',
    }
  })
}

// ─────────────────────────── 渲染（预览用） ───────────────────────────

export interface AgentExportOptions {
  target: AgentTargetId | 'custom'
  path?: string
  baseUrl: string
  apiKey: string
  model?: string
  providerName?: string
  /** 供应商 id（用于查它的 Anthropic 兼容端点） */
  providerId?: string
  /** 这把密钥原生协议，决定哪些 Agent 能用它 */
  providerProtocol?: 'openai' | 'anthropic' | 'gemini'
}

/** 去掉末尾斜杠与 /v1：Claude Code 自己会拼 /v1/messages。 */
function stripV1(url: string): string {
  return url.replace(/\/+$/, '').replace(/\/v1$/i, '')
}

/**
 * 按目标 Agent 需要的协议给出真正可用的 Base URL。
 * 返回 error 表示「这把密钥根本喂不进这个 Agent」，界面上要直接说清楚，
 * 而不是照样写一份坏配置进去。
 */
function baseForProtocol(
  opts: AgentExportOptions,
  need: 'openai' | 'anthropic' | 'gemini' | 'any'
): { base?: string; error?: string } {
  const proto = opts.providerProtocol ?? 'openai'
  if (need === 'any' || need === proto) {
    return { base: need === 'anthropic' ? stripV1(opts.baseUrl) : opts.baseUrl }
  }
  if (need === 'anthropic') {
    const mapped = opts.providerId ? ANTHROPIC_COMPAT[opts.providerId] : undefined
    if (mapped) return { base: mapped }
    return {
      error:
        '这家厂商没有提供 Anthropic 兼容端点，Claude Code / Kimi CLI 这类只认 Anthropic 协议的 Agent 用不了它。' +
        '目前确认可用的有：DeepSeek（…/anthropic）、Moonshot（…/anthropic）、小米 MiMo（…/anthropic）、智谱、MiniMax。',
    }
  }
  if (need === 'gemini') {
    return {
      error:
        'Gemini CLI 只吃 Gemini 协议（generateContent）的端点，OpenAI 兼容的密钥喂不进去。' +
        '要用 Gemini CLI，请选 Gemini 官方或其他 Gemini 兼容网关的密钥。',
    }
  }
  return { error: `这个 Agent 需要 ${need} 协议端点，而这把密钥是 ${proto} 协议。` }
}

export interface AgentFilePlan {
  path: string
  content: string
  /** 预览里怎么高亮 */
  language: 'json' | 'jsonc' | 'toml' | 'yaml' | 'env' | 'text'
}

export interface AgentPlan {
  ok: boolean
  target: string
  /** 主文件（界面显示路径用） */
  path: string
  files: AgentFilePlan[]
  /** 该 Agent 不支持直接写文件，只能复制 */
  manual: boolean
  note?: string
  error?: string
}

function stripJsonComments(input: string): string {
  let out = ''
  let i = 0
  let inStr = false
  while (i < input.length) {
    const ch = input[i]
    const next = input[i + 1]
    if (inStr) {
      out += ch
      if (ch === '\\') {
        out += next ?? ''
        i += 2
        continue
      }
      if (ch === '"') inStr = false
      i++
      continue
    }
    if (ch === '"') {
      inStr = true
      out += ch
      i++
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < input.length && input[i] !== '\n') i++
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += ch
    i++
  }
  return out
}

/** OpenClaw 的配置是 JSON5 味的（顶层键不带引号），先规整成能 JSON.parse 的样子。 */
function normalizeJson5(input: string): string {
  return input.replace(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/gm, '$1"$2":')
}

function readJsonFile(file: string, json5 = false): Record<string, any> {
  if (!existsSync(file)) return {}
  const raw = readFileSync(file, 'utf-8')
  if (!raw.trim()) return {}
  return JSON.parse(json5 ? normalizeJson5(raw) : stripJsonComments(raw))
}

function providerBlock(opts: AgentExportOptions, extra: Record<string, any> = {}): Record<string, any> {
  const model = opts.model?.trim() || ''
  return {
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    api: 'openai-completions',
    ...(model ? { model } : {}),
    ...extra,
  }
}

function modelsMap(model?: string): Record<string, any> {
  const m = model?.trim()
  if (!m) return {}
  return { [m]: { name: m } }
}

/**
 * MiMo Desktop（mimocode）的 models 结构：本机真实配置里每个模型都带 limit 与
 * modalities，缺了这两个字段它会把上下文长度当成 0，容易报错，所以照着补齐。
 */
function mimocodeModels(model?: string): Record<string, any> {
  const m = model?.trim()
  if (!m) return {}
  return {
    [m]: {
      name: m,
      limit: { context: 128000, output: 8192 },
      modalities: { input: ['text'], output: ['text'] },
    },
  }
}

function jsonContent(data: Record<string, any>): string {
  return JSON.stringify(data, null, 2) + '\n'
}

// ── JSONC 保注释写入 ────────────────────────────────────────────────
// 有些 Agent 的配置文件带注释（mimocode.jsonc），parse + stringify 会把用户的注释
// 和排版一起洗掉，所以这里用「扫描器 + 文本替换」只改我们要动的那一个键。

interface JsonMember {
  keyStart: number
  keyEnd: number
  valueStart: number
  valueEnd: number
}

function skipString(raw: string, start: number): number {
  let i = start + 1
  while (i < raw.length) {
    if (raw[i] === '\\') {
      i += 2
      continue
    }
    if (raw[i] === '"') return i + 1
    i++
  }
  return i
}

function skipValue(raw: string, start: number): number {
  const ch = raw[start]
  if (ch === '"') return skipString(raw, start)
  if (ch === '{' || ch === '[') {
    let depth = 0
    let i = start
    while (i < raw.length) {
      const c = raw[i]
      if (c === '"') {
        i = skipString(raw, i)
        continue
      }
      if (c === '{' || c === '[') depth++
      else if (c === '}' || c === ']') {
        depth--
        if (depth === 0) return i + 1
      }
      i++
    }
    return i
  }
  let i = start
  while (i < raw.length && !/[,}\]]/.test(raw[i])) i++
  return i
}

/** 扫描从 openBrace 开始的那一层对象里的所有成员（只认这一层，够用）。 */
function scanMembers(raw: string, openBrace: number): JsonMember[] {
  const members: JsonMember[] = []
  let depth = 0
  let expectingKey = false
  let i = openBrace
  while (i < raw.length) {
    const ch = raw[i]
    if (ch === '"') {
      const keyStart = i
      const keyEnd = skipString(raw, i)
      if (depth === 1 && expectingKey) {
        let j = keyEnd
        while (j < raw.length && /\s/.test(raw[j])) j++
        if (raw[j] === ':') {
          j++
          while (j < raw.length && /\s/.test(raw[j])) j++
          const valueStart = j
          const valueEnd = skipValue(raw, j)
          members.push({ keyStart, keyEnd, valueStart, valueEnd })
          i = valueEnd
          expectingKey = false
          continue
        }
      }
      i = keyEnd
      continue
    }
    if (ch === '{' || ch === '[') {
      depth++
      i++
      if (depth === 1) expectingKey = true
      continue
    }
    if (ch === '}' || ch === ']') {
      depth--
      i++
      if (depth === 0) return members
      continue
    }
    if (ch === ',' && depth === 1) {
      expectingKey = true
      i++
      continue
    }
    i++
  }
  return members
}

function detectIndent(raw: string): string {
  const m = raw.match(/\n([ \t]+)"/)
  return m ? m[1] : '  '
}

/**
 * 在 JSONC 原文里 upsert `provider.<entryKey>`，保留注释与其它字段。
 * 返回 null 表示这个文件结构超出预期，调用方回退到 parse + stringify。
 */
function upsertJsoncProviderEntry(
  raw: string,
  entryKey: string,
  valueText: string
): string | null {
  const rootOpen = raw.indexOf('{')
  if (rootOpen < 0) return null
  const indent = detectIndent(raw)
  const entry = `"${entryKey}": ${valueText}`
  const rootMembers = scanMembers(raw, rootOpen)
  const providerMember = rootMembers.find((m) => raw.slice(m.keyStart, m.keyEnd) === '"provider"')

  if (!providerMember) {
    // 根对象里还没有 provider：在开头补一个
    const after = raw.slice(rootOpen + 1).replace(/^\s*/, '')
    const head = `${raw.slice(0, rootOpen + 1)}\n${indent}"provider": {\n${indent}${indent}${entry}\n${indent}}`
    return after ? `${head},\n${indent}${after}` : `${head}\n}`
  }

  const providerOpen = providerMember.valueStart
  if (raw[providerOpen] !== '{') return null
  const members = scanMembers(raw, providerOpen)
  const existing = members.find((m) => raw.slice(m.keyStart, m.keyEnd) === `"${entryKey}"`)
  if (existing) return raw.slice(0, existing.valueStart) + valueText + raw.slice(existing.valueEnd)

  const providerClose = providerMember.valueEnd - 1 // 指向 provider 对象的 '}'
  let last = providerClose - 1
  while (last > providerOpen && /\s/.test(raw[last])) last--
  const comma = raw[last] === '{' || raw[last] === ',' ? '' : ','
  const innerIndent = indent + indent
  // 逗号要紧跟在最后一个成员后面，否则会出现 "\n  ,\n" 这种难看的排版。
  return (
    raw.slice(0, last + 1) +
    `${comma}\n${innerIndent}${entry}\n${indent}` +
    raw.slice(providerClose)
  )
}

function envSnippet(opts: AgentExportOptions): string {
  const model = opts.model?.trim() || ''
  return [
    `# ${opts.providerName ?? 'LLM API Monitor'} · LLM API Monitor 导出`,
    `export OPENAI_BASE_URL="${opts.baseUrl}"`,
    `export OPENAI_API_KEY="${opts.apiKey}"`,
    model ? `export LLM_MODEL="${model}"` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/** TOML 字符串转义（密钥里不会有引号，但 URL 可能带反斜杠）。 */
function tomlStr(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * Codex CLI：配置写在 `[model_providers.<id>]`（不是 `[providers.<id>]`），
 * 需要 name / base_url / wire_api，鉴权靠 env_key 或静态 http_headers。
 * 这里用 http_headers 直接带上 Authorization，省得用户再去设环境变量。
 * `model_provider = "llm-monitor"` 只在文件里没有这一项时补一行，不覆盖用户已有选择。
 */
function planCodexToml(path: string, opts: AgentExportOptions): string {
  let lines = (existsSync(path) ? readFileSync(path, 'utf-8') : '').split(/\r?\n/)
  const HEAD = '[model_providers.llm-monitor]'
  const START = '# --- LLM API Monitor 导出 ---'

  // 1) 清掉 v1.4.5 及更早写的旧格式（Codex 根本不读 [providers.*]）。
  const legacyTable = /^\[providers\.llm-monitor\]\s*$/
  const legacyIdx = lines.findIndex((l) => legacyTable.test(l.trim()))
  if (legacyIdx >= 0) {
    let end = lines.length
    for (let i = legacyIdx + 1; i < lines.length; i++) {
      const t = lines[i].trim()
      if (t.startsWith('[') && !legacyTable.test(t)) {
        end = i
        break
      }
    }
    lines.splice(legacyIdx, end - legacyIdx)
  }

  // 2) 清掉本工具上次写的整段（从标记到下一个「别人的」表头）。
  const startIdx = lines.findIndex((l) => l.trim() === START)
  if (startIdx >= 0) {
    let end = lines.length
    for (let i = startIdx + 1; i < lines.length; i++) {
      const t = lines[i].trim()
      if (t.startsWith('[') && !t.startsWith('[model_providers.llm-monitor')) {
        end = i
        break
      }
    }
    lines.splice(startIdx, end - startIdx)
  }

  // 3) 没有 model_provider 时补一行默认项（TOML 顶层键必须出现在任何表头之前）。
  const hasModelProvider = lines.some((l) => /^\s*model_provider\s*=/.test(l))
  if (!hasModelProvider) {
    const firstTable = lines.findIndex((l) => l.trim().startsWith('['))
    const insertAt = firstTable < 0 ? lines.length : firstTable
    lines.splice(insertAt, 0, '# Codex CLI 用下面这个 provider（LLM API Monitor 导出时补的一行）', 'model_provider = "llm-monitor"', '')
  }

  const model = opts.model?.trim() || ''
  const blockLines = [
    START,
    HEAD,
    `name = ${tomlStr(opts.providerName ?? 'LLM API Monitor')}`,
    `base_url = ${tomlStr(opts.baseUrl)}`,
    'wire_api = "chat"',
    '',
    '[model_providers.llm-monitor.http_headers]',
    `Authorization = ${tomlStr(`Bearer ${opts.apiKey}`)}`,
  ]
  if (model) blockLines.push(`# 模型 ${model}：在 Codex 里用 -m ${model} 指定，或加一行 model = "${model}"`)
  blockLines.push('')
  const block = blockLines.join('\n')

  const head = lines.join('\n').trimEnd()
  return `${head ? `${head}\n\n` : ''}${block}\n`
}

/** DSH：cordis.patch.yml 的 llm-pi-ai.providers + .credentials.yaml 的 refs。 */
function planDsh(opts: AgentExportOptions): AgentPlan {
  const patchPath = expand('~/.dsh/profiles/desktop/cordis.patch.yml')
  const credsPath = expand('~/.dsh/.credentials.yaml')
  if (!existsSync(patchPath)) {
    return {
      ok: false,
      target: 'deepseekHarness',
      path: patchPath,
      files: [],
      manual: false,
      error: `没找到 DSH 的 profile 配置：${patchPath}。请先启动一次 DSH，或确认面板里的 profile 名是不是 desktop。`,
    }
  }
  try {
    const doc = parseDocument(readFileSync(patchPath, 'utf-8'))
    const data = doc.toJS() as any
    const list: any[] = Array.isArray(data) ? data : []
    const piIndex = list.findIndex((item) => item && item.id === 'llm-pi-ai')
    const model = opts.model?.trim() || ''
    const entry: Record<string, any> = {
      apiKeyEnv: DSH_ENV,
      api: 'openai-completions',
      baseURL: opts.baseUrl,
    }
    if (model) entry.models = [{ id: model, name: model }]
    if (piIndex >= 0) {
      const providers = list[piIndex]?.config?.providers ?? {}
      doc.setIn([piIndex, 'config', 'providers', PROVIDER_KEY], entry)
      if (!providers || typeof providers !== 'object') {
        doc.setIn([piIndex, 'config', 'providers'], { [PROVIDER_KEY]: entry })
      }
    } else {
      doc.add({
        id: 'llm-pi-ai',
        name: '@deepseek-ai/dsh-llm-pi-ai',
        config: { providers: { [PROVIDER_KEY]: entry } },
      })
    }
    const patchContent = doc.toString()

    let credsContent = ''
    if (existsSync(credsPath)) {
      const cdoc = parseDocument(readFileSync(credsPath, 'utf-8'))
      cdoc.setIn(['refs', DSH_ENV], opts.apiKey)
      credsContent = cdoc.toString()
    } else {
      credsContent = `version: 1\nrefs:\n  ${DSH_ENV}: ${opts.apiKey}\n`
    }

    return {
      ok: true,
      target: 'deepseekHarness',
      path: patchPath,
      manual: false,
      note: 'DSH 需要重启后才会读到新 provider（或执行一次 面板 → 重载配置）。',
      files: [
        { path: patchPath, content: patchContent, language: 'yaml' },
        { path: credsPath, content: credsContent, language: 'yaml' },
      ],
    }
  } catch (err) {
    return {
      ok: false,
      target: 'deepseekHarness',
      path: patchPath,
      files: [],
      manual: false,
      error: `解析 DSH 配置失败：${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/** 生成「如果现在写入，这些文件会变成什么样」。 */
export function planAgentExport(opts: AgentExportOptions): AgentPlan {
  const spec = AGENT_TARGETS.find((t) => t.id === opts.target)
  const path = opts.target === 'custom' ? (opts.path?.trim() ?? '') : expand(spec?.path ?? '')
  if (opts.target !== 'custom' && !spec) {
    return { ok: false, target: opts.target, path, files: [], manual: false, error: '未知目标' }
  }
  if (!path) {
    return { ok: false, target: opts.target, path, files: [], manual: false, error: '缺少目标路径' }
  }

  // 先确认「这把密钥能不能喂进这个 Agent」——协议对不上就直接说明原因，
  // 别写一份看起来成功、实际用不了的配置。
  const need = spec?.protocol ?? 'openai'
  const resolved = baseForProtocol(opts, need)
  if (!resolved.base) {
    return { ok: false, target: opts.target, path, files: [], manual: false, error: resolved.error }
  }
  opts = { ...opts, baseUrl: resolved.base }

  if (opts.target === 'deepseekHarness') return planDsh(opts)

  if (spec?.format === 'manual') {
    return {
      ok: true,
      target: opts.target,
      path,
      manual: true,
      note: spec.note,
      files: [{ path: '(不写文件)', content: envSnippet(opts), language: 'env' }],
    }
  }

  try {
    // ── TOML ──
    if (spec?.format === 'toml' || path.toLowerCase().endsWith('.toml')) {
      return {
        ok: true,
        target: opts.target,
        path,
        manual: false,
        files: [{ path, content: planCodexToml(path, opts), language: 'toml' }],
      }
    }

    // ── MiMo Desktop：JSONC + provider 映射（要保留文件里的注释） ──
    if (opts.target === 'mimoDesktop') {
      const entry = {
        name: opts.providerName ?? 'LLM API Monitor',
        npm: '@ai-sdk/openai-compatible',
        only_configured_models: true,
        options: { apiKey: opts.apiKey, baseURL: opts.baseUrl },
        models: mimocodeModels(opts.model),
      }
      const raw = existsSync(path) ? readFileSync(path, 'utf-8') : ''
      const surgical = raw ? upsertJsoncProviderEntry(raw, PROVIDER_KEY, JSON.stringify(entry)) : null
      let content: string
      if (surgical) {
        content = surgical.endsWith('\n') ? surgical : `${surgical}\n`
      } else {
        const data = readJsonFile(path)
        data.provider = data.provider ?? {}
        data.provider[PROVIDER_KEY] = entry
        content = jsonContent(data)
      }
      return {
        ok: true,
        target: opts.target,
        path,
        manual: false,
        files: [{ path, content, language: 'jsonc' }],
      }
    }

    // ── OpenClaw ──
    if (opts.target === 'openclaw') {
      const data = readJsonFile(path, true)
      data.models = data.models ?? {}
      data.models.mode = data.models.mode ?? 'merge'
      data.models.providers = data.models.providers ?? {}
      const model = opts.model?.trim() || ''
      data.models.providers[PROVIDER_KEY] = {
        baseUrl: opts.baseUrl,
        apiKey: opts.apiKey,
        api: 'openai-completions',
        models: model ? [{ id: model, name: model, contextWindow: 128000, maxTokens: 8192 }] : [],
      }
      return {
        ok: true,
        target: opts.target,
        path,
        manual: false,
        files: [{ path, content: jsonContent(data), language: 'json' }],
      }
    }

    // ── 其余 JSON 配置：按各家 schema 合并不覆盖 ──
    const data = readJsonFile(path)
    switch (opts.target) {
      case 'claudeCode':
        // Claude Code 读 settings.json 的 env：密钥走 AUTH_TOKEN / API_KEY，端点走
        // ANTHROPIC_BASE_URL（它自己拼 /v1/messages，所以这里不能带 /v1）。
        // SMALL_FAST_MODEL 必须一起给，否则它默认去找 haiku，第三方端点没有这个模型。
        data.env = {
          ...(data.env ?? {}),
          ANTHROPIC_API_KEY: opts.apiKey,
          ANTHROPIC_AUTH_TOKEN: opts.apiKey,
          ANTHROPIC_BASE_URL: opts.baseUrl,
          ...(opts.model?.trim()
            ? {
                ANTHROPIC_MODEL: opts.model.trim(),
                ANTHROPIC_SMALL_FAST_MODEL: opts.model.trim(),
              }
            : {}),
        }
        if (opts.model?.trim()) data.model = opts.model.trim()
        break
      case 'gemini':
        data.env = {
          ...(data.env ?? {}),
          GEMINI_API_KEY: opts.apiKey,
          GOOGLE_GEMINI_BASE_URL: opts.baseUrl,
        }
        if (opts.model?.trim()) data.model = opts.model.trim()
        break
      case 'openCode':
        data['$schema'] = data['$schema'] ?? 'https://opencode.ai/config.json'
        data.provider = data.provider ?? {}
        data.provider[PROVIDER_KEY] = {
          npm: '@ai-sdk/openai-compatible',
          name: opts.providerName ?? 'LLM API Monitor',
          options: { baseURL: opts.baseUrl, apiKey: opts.apiKey },
          models: modelsMap(opts.model),
        }
        break
      case 'codebuddy':
      case 'workbuddy':
        data.env = {
          ...(data.env ?? {}),
          CODEBUDDY_API_KEY: opts.apiKey,
          CODEBUDDY_BASE_URL: opts.baseUrl,
        }
        data.provider = data.provider ?? {}
        data.provider[PROVIDER_KEY] = providerBlock(opts)
        break
      case 'doubao':
        data.env = {
          ...(data.env ?? {}),
          DOUBAO_API_KEY: opts.apiKey,
          DOUBAO_BASE_URL: opts.baseUrl,
        }
        data.provider = data.provider ?? {}
        data.provider[PROVIDER_KEY] = providerBlock(opts)
        break
      case 'marscode':
      case 'coze':
        data.env = {
          ...(data.env ?? {}),
          OPENAI_API_KEY: opts.apiKey,
          OPENAI_BASE_URL: opts.baseUrl,
        }
        data.provider = data.provider ?? {}
        data.provider[PROVIDER_KEY] = providerBlock(opts)
        break
      default:
        if (opts.target === 'custom') {
          data.baseUrl = opts.baseUrl
          data.apiKey = opts.apiKey
          if (opts.model?.trim()) data.model = opts.model.trim()
          data.provider = data.provider ?? {}
          data.provider[PROVIDER_KEY] = providerBlock(opts)
        } else {
          data.provider = data.provider ?? {}
          data.provider[PROVIDER_KEY] = providerBlock(opts)
        }
    }
    return {
      ok: true,
      target: opts.target,
      path,
      manual: false,
      files: [{ path, content: jsonContent(data), language: 'json' }],
    }
  } catch (err) {
    return {
      ok: false,
      target: opts.target,
      path,
      files: [],
      manual: false,
      error: `读取现有配置失败（不敢覆盖，已取消）：${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/** 第一次改别人的配置前留一份备份。 */
function backupConfigOnce(targetPath: string): void {
  try {
    if (!existsSync(targetPath)) return
    const bak = `${targetPath}.llm-monitor.bak`
    if (existsSync(bak)) return
    copyFileSync(targetPath, bak)
  } catch {
    /* 备份失败不阻断写入 */
  }
}

/** 回读校验：确认写入的文件能被解析、且真的带上了我们的配置。 */
export function verifyAgentConfig(plan: AgentPlan): { ok: boolean; error?: string } {
  for (const file of plan.files) {
    if (!existsSync(file.path)) return { ok: false, error: `写入后找不到文件：${file.path}` }
    const text = readFileSync(file.path, 'utf-8')
    try {
      if (file.language === 'json') {
        JSON.parse(text)
      } else if (file.language === 'jsonc') {
        JSON.parse(stripJsonComments(text))
      } else if (file.language === 'yaml') {
        const doc = parseDocument(text)
        const errs = doc.errors
        if (errs.length > 0) return { ok: false, error: `YAML 校验失败：${errs[0].message}` }
      } else if (file.language === 'toml') {
        if (!text.includes('[model_providers.llm-monitor]')) {
          return { ok: false, error: 'TOML 写入后没找到 [model_providers.llm-monitor]' }
        }
      }
    } catch (err) {
      return { ok: false, error: `回读校验失败：${err instanceof Error ? err.message : String(err)}` }
    }
  }
  return { ok: true }
}

/** 真正落盘：先备份、再写、最后回读校验。 */
export function applyAgentExport(opts: AgentExportOptions): {
  ok: boolean
  path: string
  files: string[]
  error?: string
} {
  const plan = planAgentExport(opts)
  if (!plan.ok) return { ok: false, path: plan.path, files: [], error: plan.error }
  if (plan.manual) return { ok: true, path: plan.path, files: [] }
  try {
    for (const file of plan.files) {
      mkdirSync(dirname(file.path), { recursive: true })
      backupConfigOnce(file.path)
      writeFileSync(file.path, file.content, 'utf-8')
    }
  } catch (err) {
    return { ok: false, path: plan.path, files: [], error: err instanceof Error ? err.message : String(err) }
  }
  const verify = verifyAgentConfig(plan)
  if (!verify.ok) {
    return { ok: false, path: plan.path, files: plan.files.map((f) => f.path), error: verify.error }
  }
  return { ok: true, path: plan.path, files: plan.files.map((f) => f.path) }
}
