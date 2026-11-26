/**
 * 「导出到 Agent」通道体检。
 *
 * 做三件事：
 *   1. 在临时 HOME 里伪造「19 个 Agent 全都装了」+ 每个目标都已有一份用户配置，
 *      逐个跑 previewAgentExport → applyAgentExport，再从磁盘回读校验；
 *   2. 校验「协议能不能对上」：把同一把 OpenAI 兼容密钥喂给 Claude Code / Gemini CLI /
 *      Codex，该给的给对端点、该拒绝的明确拒绝（不能写坏配置）；
 *   3. 打印一张表：目标 / 可信度 / 预演 / 写入 / 用户配置是否保留 / 结论。
 *
 * 用法：node scripts/check-agent-export.mjs [--verbose]
 */
import { build } from 'esbuild'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const VERBOSE = process.argv.includes('--verbose')
const ROOT = join(tmpdir(), 'llm-monitor-agent-check')
const HOME = join(ROOT, 'home')
const APPDATA = join(ROOT, 'appdata')
// 产物放在仓库里，才能让 node 从 node_modules 解析 external 的 yaml（CJS 包塞进 ESM bundle 会炸）
const BUNDLE = join(REPO, '.agent-check-bundle.mjs')

// ── 1. 编译被测模块（它只依赖 fs/os/path/yaml，可以直接在 Node 里跑） ──
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(HOME, { recursive: true })
mkdirSync(APPDATA, { recursive: true })
await build({
  entryPoints: [join(REPO, 'src/main/agentExport.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: BUNDLE,
  external: ['yaml'],
  logLevel: 'warning',
})

// 模块里的 homedir()/expand() 都按进程环境解析，所以在 import 之前改环境变量。
process.env.USERPROFILE = HOME
process.env.HOME = HOME
process.env.APPDATA = APPDATA
const mod = await import(`file://${BUNDLE.replace(/\\/g, '/')}?t=${Date.now()}`)
const { AGENT_TARGETS, detectAgentTargets, planAgentExport, applyAgentExport } = mod

const expand = (tpl) => {
  let out = tpl
  if (out === '~') return HOME
  if (out.startsWith('~/')) out = join(HOME, out.slice(2))
  out = out.replace(/%([A-Za-z_]+)%/g, (_m, name) => process.env[name.toUpperCase()] ?? '')
  if (!/^[A-Za-z]:[\\/]/.test(out) && !out.startsWith('/')) out = join(HOME, out)
  return out
}

// ── 2. 伪造安装证据 + 每个目标已有的用户配置 ──
const FIXTURE = {
  json: (id) =>
    JSON.stringify(
      {
        keepMe: `sentinel-${id}`,
        env: { KEEP_ME: '1' },
        provider: { 'user-probe': { keep: true } },
        models: { providers: { 'user-probe': { keep: true } } },
      },
      null,
      2
    ) + '\n',
  jsonc: () =>
    `{\n  // 用户自己的注释，写入后不能丢\n  "keepMe": "sentinel",\n  "provider": {\n    "user-probe": { "keep": true }\n  }\n}\n`,
  toml: () =>
    `[profiles.fast]\nmodel = "gpt-4o-mini"\n\n[model_providers.other]\nname = "other"\nbase_url = "https://example.com/v1"\n`,
  yaml: () =>
    `- id: llm-pi-ai\n  name: "@deepseek-ai/dsh-llm-pi-ai"\n  config:\n    providers:\n      xiaomi:\n        apiKeyEnv: XIAOMI_API_KEY\n        api: openai-completions\n        baseURL: https://api.xiaomimimo.com/v1\n        models:\n          - id: mimo-v2.6-flash\n            name: MiMo Flash\n`,
}

for (const spec of AGENT_TARGETS) {
  for (const dir of spec.dirs ?? []) {
    mkdirSync(expand(dir), { recursive: true })
  }
  const path = expand(spec.path)
  if (spec.format === 'manual') continue
  mkdirSync(dirname(path), { recursive: true })
  if (spec.format === 'yaml' && spec.id === 'deepseekHarness') {
    // DSH 还要一份 credentials
    const creds = expand('~/.dsh/.credentials.yaml')
    mkdirSync(dirname(creds), { recursive: true })
    writeFileSync(creds, `version: 1\nrefs:\n  XIAOMI_API_KEY: sk-xiaomi\n  KIMI_API_KEY: sk-kimi\n`, 'utf8')
  }
  writeFileSync(path, FIXTURE[spec.format](spec.id), 'utf8')
}
// DSH 的 patch 文件路径不在 spec.path 里可能不一致，这里单独确保存在
const dshPatch = expand('~/.dsh/profiles/desktop/cordis.patch.yml')
if (!existsSync(dshPatch)) {
  mkdirSync(dirname(dshPatch), { recursive: true })
  writeFileSync(dshPatch, FIXTURE.yaml(), 'utf8')
}

// 自定义目标：写到任意路径
const customPath = join(HOME, 'custom-agent', 'config.json')
mkdirSync(dirname(customPath), { recursive: true })
writeFileSync(customPath, FIXTURE.json('custom'), 'utf8')

const detected = detectAgentTargets()
const missingEvidence = detected.filter((t) => !t.installed).map((t) => t.id)

// ── 3. 各种密钥画像（真实厂商 + 两种对照协议） ──
const PROFILES = [
  { id: 'deepseek', name: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', key: 'sk-deepseek-check', model: 'deepseek-chat' },
  { id: 'moonshot', name: 'Moonshot', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1', key: 'sk-moonshot-check', model: 'kimi-k3' },
  { id: 'mimo', name: '小米 MiMo', protocol: 'openai', baseUrl: 'https://api.xiaomimimo.com/v1', key: 'sk-mimo-check', model: 'mimo-v2.6-flash' },
  { id: 'unknown-openai', name: '某 OpenAI 兼容站', protocol: 'openai', baseUrl: 'https://api.example.com/v1', key: 'sk-generic', model: 'gpt-4o-mini' },
  { id: 'gemini', name: 'Gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', key: 'AIza-check', model: 'gemini-2.5-flash' },
  { id: 'anthropic', name: 'Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', key: 'sk-ant-check', model: 'claude-haiku-4-5' },
]

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  if (!ok || VERBOSE) console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  return ok
}

/** 回读：按文件格式解析，确认能解析、我们那条在、用户的东西还在。 */
function verifyFile(file, language, id, profile) {
  const text = readFileSync(file, 'utf8')
  const base = file.split(/[\\/]/).pop()
  if (language === 'json' || language === 'jsonc') {
    let json
    try {
      json = JSON.parse(language === 'jsonc' ? text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '') : text)
    } catch (err) {
      return { ok: false, error: `JSON 解析失败：${err.message}` }
    }
    const flat = JSON.stringify(json)
    const keep = flat.includes(`sentinel-${id}`) || flat.includes('sentinel') || flat.includes('"KEEP_ME"') || flat.includes('user-probe')

    // Claude Code / Gemini CLI 吃的是 env，不是 provider 条目，别按 llm-monitor 找。
    if (id === 'claudeCode') {
      const env = json.env ?? {}
      const endpoint = env.ANTHROPIC_BASE_URL ?? ''
      const ours = !!endpoint && !/\/v1$/.test(endpoint) && !!env.ANTHROPIC_AUTH_TOKEN && !!env.ANTHROPIC_SMALL_FAST_MODEL
      return {
        ok: ours && keep,
        error: !env.ANTHROPIC_BASE_URL
          ? '没写 ANTHROPIC_BASE_URL'
          : /\/v1$/.test(endpoint)
            ? 'ANTHROPIC_BASE_URL 带了 /v1（Claude Code 自己会拼）'
            : !env.ANTHROPIC_SMALL_FAST_MODEL
              ? '缺 ANTHROPIC_SMALL_FAST_MODEL'
              : !keep
                ? '用户的旧配置被冲掉了'
                : undefined,
        endpoint,
      }
    }
    if (id === 'gemini') {
      const env = json.env ?? {}
      const ours = !!env.GEMINI_API_KEY && !!env.GOOGLE_GEMINI_BASE_URL
      return { ok: ours && keep, error: !ours ? '没写 GEMINI_API_KEY/GOOGLE_GEMINI_BASE_URL' : !keep ? '用户的旧配置被冲掉了' : undefined, endpoint: env.GOOGLE_GEMINI_BASE_URL }
    }

    const ours = flat.includes('llm-monitor')
    return { ok: ours && keep, error: !ours ? '没找到 llm-monitor 条目' : !keep ? '用户的旧配置被冲掉了' : undefined, json }
  }
  if (language === 'toml') {
    const ours = text.includes('[model_providers.llm-monitor]') && text.includes('wire_api = "chat"')
    const keep = text.includes('[profiles.fast]') && text.includes('[model_providers.other]')
    const stale = text.includes('[providers.llm-monitor]')
    return { ok: ours && keep && !stale, error: !ours ? '缺少 [model_providers.llm-monitor]' : !keep ? '用户的 TOML 表被冲掉' : stale ? '旧格式没清掉' : undefined }
  }
  if (language === 'yaml') {
    if (base === '.credentials.yaml') {
      const ours = text.includes('LLM_MONITOR_API_KEY')
      const keep = text.includes('XIAOMI_API_KEY') && text.includes('KIMI_API_KEY')
      return { ok: ours && keep, error: !ours ? '凭据里没写 LLM_MONITOR_API_KEY' : !keep ? '用户原有凭据丢了' : undefined }
    }
    const ours = text.includes('llm-monitor') && text.includes('LLM_MONITOR_API_KEY')
    const keep = text.includes('xiaomi') && text.includes('XIAOMI_API_KEY')
    return { ok: ours && keep, error: !ours ? '没写入 llm-monitor provider' : !keep ? '用户原有 provider 丢了' : undefined }
  }
  return { ok: text.includes('llm-monitor'), error: undefined }
}

// ── 4. 主矩阵：每个目标 × 一把「协议匹配」的密钥 ──
console.log('\n=== 写入通道体检（临时 HOME，可随意折腾） ===')
const planOf = (target, profile, path) => {
  const opts = {
    target,
    baseUrl: profile.baseUrl,
    apiKey: profile.key,
    model: profile.model,
    providerName: profile.name,
    providerId: profile.id,
    providerProtocol: profile.protocol,
  }
  if (path) opts.path = path
  return opts
}

const targetRows = []
const infoById = new Map(detected.map((t) => [t.id, t]))
for (const spec of AGENT_TARGETS.concat([{ id: 'custom', label: '自定义 JSON', format: 'json', path: '(自定义)' }])) {
  const profile = spec.id === 'gemini' ? PROFILES[4] : PROFILES[1] // Gemini 用 Gemini 密钥，其余先按 OpenAI 密钥试
  const opts = planOf(spec.id, profile, spec.id === 'custom' ? customPath : undefined)
  const plan = planAgentExport(opts)
  const row = {
    target: spec.label,
    id: spec.id,
    confidence: infoById.get(spec.id)?.confidence ?? 'documented',
    preview: plan.ok,
    write: false,
    preserved: false,
    note: '',
  }

  if (!plan.ok) {
    row.note = plan.error ?? '预演失败'
    targetRows.push(row)
    check(`${spec.id} 预演`, false, row.note)
    continue
  }
  check(`${spec.id} 预演`, true, plan.manual ? '仅复制' : plan.files.map((f) => f.path).join(', '))

  if (plan.manual) {
    row.write = true
    row.preserved = true
    row.note = '不写文件（只复制）'
    targetRows.push(row)
    continue
  }

  const applied = applyAgentExport(opts)
  row.write = applied.ok
  if (!applied.ok) {
    row.note = applied.error ?? '写入失败'
    targetRows.push(row)
    check(`${spec.id} 写入`, false, row.note)
    continue
  }
  check(`${spec.id} 写入`, true, applied.files.join(', '))

  let preserved = true
  for (const file of plan.files) {
    const v = verifyFile(file.path, file.language, spec.id, profile)
    if (!v.ok) {
      preserved = false
      row.note = v.error ?? '回读校验失败'
      check(`${spec.id} 回读`, false, row.note)
    }
  }
  // 覆盖前应留 .bak
  const bak = plan.files.some((f) => existsSync(`${f.path}.llm-monitor.bak`))
  row.preserved = preserved
  row.backup = bak
  if (preserved) check(`${spec.id} 回读`, true, '我们那条在、用户那条也在')
  targetRows.push(row)
}

// ── 5. 协议矩阵：同一把 OpenAI 密钥喂给三种专用 Agent ──
console.log('\n=== 协议是否对得上 ===')
const protocolRows = []
for (const target of ['claudeCode', 'codex', 'gemini']) {
  for (const profile of PROFILES) {
    const plan = planAgentExport(planOf(target, profile))
    const expectOk = target === 'claudeCode'
      ? profile.protocol === 'anthropic' || ['deepseek', 'moonshot', 'mimo'].includes(profile.id)
      : target === 'codex'
        ? profile.protocol === 'openai'
        : profile.protocol === 'gemini'
    const row = { target, profile: profile.name, expectOk, ok: plan.ok, error: plan.error ?? '' }
    if (plan.ok) {
      const body = plan.files.map((f) => f.content).join('\n')
      if (target === 'claudeCode') {
        let endpoint = '(未写出)'
        try {
          endpoint = JSON.parse(body).env?.ANTHROPIC_BASE_URL ?? '(未写出)'
        } catch {
          endpoint = /ANTHROPIC_BASE_URL["\s:=]+([^"\\]+)/.exec(body)?.[1] ?? '(未写出)'
        }
        row.endpoint = endpoint
        if (/\/v1$/.test(endpoint)) row.error = 'ANTHROPIC_BASE_URL 带了 /v1'
        if (!body.includes('ANTHROPIC_SMALL_FAST_MODEL')) row.error = row.error || '缺 ANTHROPIC_SMALL_FAST_MODEL'
      }
      if (target === 'codex') {
        if (!body.includes('[model_providers.llm-monitor]')) row.error = '没写 model_providers'
        if (!body.includes('Authorization')) row.error = row.error || '没写鉴权头'
      }
    }
    if (row.error) row.ok = false
    protocolRows.push(row)
    check(`${target} × ${profile.name}`, row.ok === row.expectOk, `期望${expectOk ? '可用' : '拒绝'}，实际${row.ok ? '可用' : '拒绝'}${row.endpoint ? `，端点 ${row.endpoint}` : ''}${row.error ? `，${row.error}` : ''}`)
  }
}

// ── 6. 汇总 ──
const bad = results.filter((r) => !r.ok)
console.log('\n=== 写入通道汇总 ===')
for (const row of targetRows) {
  console.log(
    `${row.ok === false ? '✗' : ' '} ${row.target.padEnd(24, ' ')} ${row.confidence.padEnd(11, ' ')} 预演${row.preview ? '✓' : '✗'} 写入${row.write ? '✓' : '✗'} 保留${row.preserved ? '✓' : '✗'} ${row.note ?? ''}`
  )
}
console.log('\n=== 协议矩阵 ===')
for (const row of protocolRows) {
  console.log(`  ${row.target.padEnd(11)} × ${row.profile.padEnd(14)} → ${row.ok ? '可用' : '拒绝'}${row.endpoint ? ` (${row.endpoint})` : ''}${row.error ? ` · ${row.error}` : ''}`)
}

console.log(`\n检测到的已安装目标：${detected.filter((t) => t.installed).length}/${detected.length}${missingEvidence.length ? `（缺证据：${missingEvidence.join(', ')}）` : ''}`)
rmSync(BUNDLE, { force: true })
console.log(bad.length === 0 ? '\n全部通过 ✓' : `\n${bad.length} 项未通过 ✗`)
process.exit(bad.length === 0 ? 0 : 1)
