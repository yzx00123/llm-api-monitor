import { useState, useEffect, useCallback, useMemo } from 'react'
import type { Provider } from '../preload'

interface Props {
  provider: Provider
  apiKey: string
  /** full key -> custom display name */
  label?: string
  onClose: () => void
}

type AgentTarget =
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
  | 'clip-env'
  | 'clip-json'

const TARGETS: Array<{ id: AgentTarget; label: string; hint: string }> = [
  { id: 'mimoDesktop', label: '小米 MiMo Desktop', hint: '写入 ~/.config/mimocode/mimocode.jsonc' },
  { id: 'deepseekHarness', label: 'DeepSeek Harness', hint: '写入 ~/.deepseek-harness/config.json' },
  { id: 'kimiCode', label: 'Kimi Code（月之暗面）', hint: '写入 ~/.kimi/config.json' },
  { id: 'minimaxCode', label: 'MiniMax Code', hint: '写入 ~/.minimax-code/config.json' },
  { id: 'openclaw', label: 'OpenClaw', hint: '写入 ~/.openclaw/openclaw.json 的 providers' },
  { id: 'codebuddy', label: '腾讯 CodeBuddy', hint: '写入 ~/.codebuddy/settings.json（env + provider）' },
  { id: 'workbuddy', label: '腾讯 WorkBuddy', hint: '写入 ~/.workbuddy/config.json' },
  { id: 'baiduComate', label: '百度文心快码 Comate', hint: '写入 ~/.comate/mcp.local.json' },
  { id: 'byteTrae', label: '字节 Trae', hint: '写入 ~/.trae/config.json' },
  { id: 'doubao', label: '字节 豆包 Doubao', hint: '写入 ~/.doubao/config.json（DOUBAO_API_KEY）' },
  { id: 'marscode', label: '字节 MarsCode', hint: '写入 ~/.marscode/config.json' },
  { id: 'coze', label: '扣子 Coze', hint: '写入 ~/.coze/config.json' },
  { id: 'aliQoder', label: '阿里 Qoder', hint: '写入 ~/.qoder/config.json' },
  { id: 'aliLingma', label: '通义灵码 Lingma', hint: '写入 ~/.lingma/config.json' },
  { id: 'claudeCode', label: 'Claude Code', hint: '写入 ~/.claude/settings.json 的 env' },
  { id: 'gemini', label: 'Gemini CLI', hint: '写入 ~/.gemini/settings.json 的 env' },
  { id: 'cursorUser', label: 'Cursor', hint: '写入 ~/.cursor/mcp.json（备注字段）' },
  { id: 'codex', label: 'Codex', hint: '追加到 ~/.codex/config.toml' },
  { id: 'openCode', label: 'OpenCode', hint: '写入 ~/.config/opencode/opencode.json' },
  { id: 'clip-env', label: '复制环境变量', hint: 'OPENAI_BASE_URL / OPENAI_API_KEY' },
  { id: 'clip-json', label: '复制 JSON', hint: 'OpenAI 兼容配置片段' },
  { id: 'custom', label: '自定义路径…', hint: '写入你指定的配置文件' },
]

function buildEnv(provider: Provider, key: string, model?: string) {
  const m = model || provider.models[0] || ''
  return [
    `# ${provider.name} · LLM API Monitor 导出`,
    `export OPENAI_BASE_URL="${provider.baseUrl}"`,
    `export OPENAI_API_KEY="${key}"`,
    `export ANTHROPIC_BASE_URL="${provider.baseUrl}"`,
    `export ANTHROPIC_API_KEY="${key}"`,
    m ? `export LLM_MODEL="${m}"` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

function buildJson(provider: Provider, key: string, model?: string) {
  const m = model || provider.models[0] || ''
  return JSON.stringify(
    {
      baseUrl: provider.baseUrl,
      apiKey: key,
      model: m || undefined,
      protocol: provider.protocol,
      note: `${provider.name} · 由 LLM API Monitor 导出`,
    },
    null,
    2
  )
}

export default function AgentExportModal({ provider, apiKey, label, onClose }: Props) {
  const [target, setTarget] = useState<AgentTarget | 'clip-env' | 'clip-json'>('claudeCode')
  const [model, setModel] = useState(provider.models[0] ?? '')
  const [customPath, setCustomPath] = useState('')
  const [cfgMap, setCfgMap] = useState<Record<string, { path: string; exists: boolean }>>({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [msgOk, setMsgOk] = useState(true)

  useEffect(() => {
    window.electronAPI.detectAgentConfigs().then(setCfgMap).catch(() => {})
  }, [])

  const envText = useMemo(() => buildEnv(provider, apiKey, model), [provider, apiKey, model])
  const jsonText = useMemo(() => buildJson(provider, apiKey, model), [provider, apiKey, model])

  const flash = useCallback((m: string, ok = true) => {
    setMsg(m)
    setMsgOk(ok)
    setTimeout(() => setMsg(''), 3500)
  }, [])

  const isWriteTarget = !target.startsWith('clip-')
  const cfg = cfgMap[target as AgentTarget]

  const handleCopy = useCallback(
    async (text: string, what: string) => {
      await window.electronAPI.copyText(text)
      flash(`已复制${what}`)
    },
    [flash]
  )

  const handleWrite = useCallback(async () => {
    setBusy(true)
    try {
      if (target === 'clip-env') {
        await window.electronAPI.copyText(envText)
        flash('已复制环境变量')
        return
      }
      if (target === 'clip-json') {
        await window.electronAPI.copyText(jsonText)
        flash('已复制 JSON')
        return
      }
      const res = await window.electronAPI.writeAgentConfig({
        target: target as Exclude<AgentTarget, 'clip-env' | 'clip-json'>,
        path: target === 'custom' ? customPath.trim() : undefined,
        baseUrl: provider.baseUrl,
        apiKey,
        model: model || undefined,
      })
      if (res.ok) {
        flash(`已写入 ${res.path}`)
        const m = await window.electronAPI.detectAgentConfigs()
        setCfgMap(m)
      } else {
        flash(res.error || '写入失败', false)
      }
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err), false)
    } finally {
      setBusy(false)
    }
  }, [target, envText, jsonText, customPath, provider.baseUrl, apiKey, model, flash])

  const handleSaveFile = useCallback(async () => {
    const content = target === 'clip-json' ? jsonText : envText
    const name = `${provider.id}-agent.${target === 'clip-json' ? 'json' : 'env'}`
    const res = await window.electronAPI.saveTextFile({ defaultName: name, content })
    if (res.ok) flash(`已保存 ${res.path}`)
  }, [target, envText, jsonText, provider.id, flash])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-agent" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>
            导出到 Agent
            <span className="agent-key-label">
              {label || provider.name} · {provider.baseUrl.replace(/^https?:\/\//, '')}
            </span>
          </h3>
          <button className="modal-close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="modal-body">
          <div className="agent-target-list">
            {TARGETS.map((t) => {
              const info = cfgMap[t.id as AgentTarget]
              return (
                <button
                  key={t.id}
                  type="button"
                  className={`agent-target ${target === t.id ? 'active' : ''}`}
                  onClick={() => setTarget(t.id)}
                >
                  <div className="agent-target-top">
                    <span className="agent-target-name">{t.label}</span>
                    {info && (
                      <span className={`agent-target-tag ${info.exists ? 'ok' : 'off'}`}>
                        {info.exists ? '已安装' : '未检测到'}
                      </span>
                    )}
                  </div>
                  <div className="agent-target-hint">{t.hint}</div>
                </button>
              )
            })}
          </div>

          <div className="form-group" style={{ marginTop: 14 }}>
            <label>模型（可选，写入配置）</label>
            <input
              className="form-input"
              list="agent-model-list"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="留空用厂商默认"
            />
            <datalist id="agent-model-list">
              {provider.models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </div>

          {target === 'custom' && (
            <div className="form-group" style={{ marginTop: 10 }}>
              <label>自定义配置文件路径</label>
              <input
                className="form-input"
                value={customPath}
                onChange={(e) => setCustomPath(e.target.value)}
                placeholder="C:\path\to\config.json"
              />
            </div>
          )}

          {target === 'codex' && (
            <div className="form-group" style={{ marginTop: 10 }}>
              <label>配置路径</label>
              <input className="form-input" value={cfg?.path ?? '~/.codex/config.toml'} readOnly />
            </div>
          )}

          <div className="form-group" style={{ marginTop: 10 }}>
            <label>预览</label>
            <pre className="agent-preview">{target === 'clip-json' ? jsonText : envText}</pre>
          </div>

          {msg && <div className={msgOk ? 'success-msg' : 'error-msg'}>{msg}</div>}
        </div>

        <div className="modal-footer">
          <button className="btn-secondary" onClick={handleSaveFile}>
            另存为文件
          </button>
          <button
            className="btn-secondary"
            onClick={() => handleCopy(target === 'clip-json' ? jsonText : envText, '配置')}
          >
            复制配置
          </button>
          <button className="btn-secondary" onClick={() => handleCopy(apiKey, '密钥')}>
            复制密钥
          </button>
          <button className="btn btn-start" onClick={() => void handleWrite()} disabled={busy}>
            {busy ? '处理中…' : isWriteTarget ? '写入 Agent' : '复制到剪贴板'}
          </button>
        </div>
      </div>
    </div>
  )
}
