import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import type { Provider, LatencyTestResult } from '../preload'

interface Props {
  providers: Provider[]
  keys: Record<string, string[]>
  keyLabels: Record<string, string>
  /** When embedded in 设置, hide the back button / page title. */
  onBack?: () => void
  embedded?: boolean
}

type AppSettingsLike = {
  probeText: string
  probeMaxTokens: number
  probeModel: string
}

function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 12) return key
  return `${key.slice(0, 6)}••••${key.slice(-4)}`
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

function latencyClass(ms: number): string {
  if (ms < 500) return 'good'
  if (ms < 2000) return 'warn'
  return 'bad'
}

/**
 * 测延迟 = the app's latency-testing SETTINGS.
 * These fields persist and drive every dashboard probe (not just a one-off test).
 */
export default function LatencyTest({ providers, keys, keyLabels, onBack, embedded }: Props) {
  // ── Saved settings (drive all probes) ────────────────────────
  const [probeText, setProbeText] = useState('请用一句话介绍你自己。')
  const [probeMaxTokens, setProbeMaxTokens] = useState(16)
  const [probeModel, setProbeModel] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  // ── Live test target ─────────────────────────────────────────
  const [providerId, setProviderId] = useState('')
  const [keyIndex, setKeyIndex] = useState(0)
  const [customKey, setCustomKey] = useState('')
  const [useCustomKey, setUseCustomKey] = useState(false)
  const [model, setModel] = useState('')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<LatencyTestResult | null>(null)
  const [history, setHistory] = useState<
    Array<{ id: number; model: string; latencyMs: number; ok: boolean; at: string; error?: string }>
  >([])
  const seqRef = useRef(0)

  // Model catalog
  const [apiModels, setApiModels] = useState<string[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState('')
  const [modelFilter, setModelFilter] = useState('')
  const [fetchSeq, setFetchSeq] = useState(0)

  const provider = useMemo(
    () => providers.find((p) => p.id === providerId) ?? null,
    [providers, providerId]
  )
  const providerKeys = useMemo(() => keys[providerId] ?? [], [keys, providerId])
  const availableProviders = useMemo(
    () => providers.filter((p) => (keys[p.id] ?? []).length > 0),
    [providers, keys]
  )

  // Load saved settings once
  useEffect(() => {
    window.electronAPI
      .getSettings()
      .then((s) => {
        const a = s as unknown as AppSettingsLike
        if (typeof a.probeText === 'string' && a.probeText) setProbeText(a.probeText)
        if (typeof a.probeMaxTokens === 'number' && a.probeMaxTokens > 0) setProbeMaxTokens(a.probeMaxTokens)
        if (typeof a.probeModel === 'string') setProbeModel(a.probeModel)
      })
      .catch(() => {})
  }, [])

  // Auto-select first provider with keys
  useEffect(() => {
    if (providerId) {
      if ((keys[providerId] ?? []).length === 0 && !useCustomKey) setProviderId('')
      return
    }
    const first = availableProviders[0]
    if (first) setProviderId(first.id)
  }, [availableProviders, keys, providerId, useCustomKey])

  useEffect(() => {
    setKeyIndex(0)
    setModelFilter('')
    const p = providers.find((x) => x.id === providerId)
    if (p) setModel(probeModel || p.models[0] || '')
  }, [providerId, providers, probeModel])

  const effectiveKey = useCustomKey ? customKey.trim() : (providerKeys[keyIndex] ?? '')

  // Fetch full model catalog from the provider
  useEffect(() => {
    if (!providerId || !effectiveKey) {
      setApiModels([])
      setModelsError('')
      return
    }
    let cancelled = false
    setModelsLoading(true)
    setModelsError('')
    window.electronAPI
      .listModels(providerId, effectiveKey)
      .then((res) => {
        if (cancelled) return
        if (res.ok && res.models.length > 0) {
          setApiModels(res.models)
          setModel((m) => (m && res.models.includes(m) ? m : res.models[0] ?? ''))
        } else {
          setApiModels([])
          setModelsError(res.error || '未能拉取模型列表')
          const p = providers.find((x) => x.id === providerId)
          if (p && p.models.length) setModel((m) => m || p.models[0])
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setApiModels([])
          setModelsError(err instanceof Error ? err.message : String(err))
        }
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [providerId, effectiveKey, providers, fetchSeq])

  const refreshModels = useCallback(() => setFetchSeq((s) => s + 1), [])

  const builtinModels = useMemo(() => provider?.models ?? [], [provider])
  const allModelIds = useMemo(() => {
    const merged = [...apiModels]
    for (const m of builtinModels) if (!merged.includes(m)) merged.push(m)
    return merged
  }, [apiModels, builtinModels])

  const visibleModels = useMemo(() => {
    const q = modelFilter.trim().toLowerCase()
    if (!q) return allModelIds
    return allModelIds.filter((m) => m.toLowerCase().includes(q))
  }, [allModelIds, modelFilter])

  /** Persist settings — these drive every dashboard latency probe. */
  const saveSettings = useCallback(async () => {
    setSaving(true)
    try {
      await window.electronAPI.updateSettings({
        probeText: probeText.trim() || '请用一句话介绍你自己。',
        probeMaxTokens: Math.max(1, Math.min(4096, probeMaxTokens || 64)),
        probeModel: probeModel.trim(),
      })
      setSavedAt(Date.now())
      setTimeout(() => setSavedAt(null), 3000)
    } finally {
      setSaving(false)
    }
  }, [probeText, probeMaxTokens, probeModel])

  const canRun = !running && !!providerId && !!effectiveKey && !!model.trim() && !!probeText.trim()

  /** One-off test using current form values; result also lands on the dashboard card. */
  const runTest = useCallback(async () => {
    if (!canRun) return
    setRunning(true)
    setResult(null)
    try {
      const res = await window.electronAPI.latencyTest({
        providerId,
        key: effectiveKey,
        model: model.trim(),
        text: probeText.trim(),
        maxTokens: probeMaxTokens,
      })
      setResult(res)
      seqRef.current += 1
      setHistory((h) =>
        [
          {
            id: seqRef.current,
            model: res.model,
            latencyMs: res.latencyMs,
            ok: res.ok,
            at: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
            error: res.error,
          },
          ...h,
        ].slice(0, 20)
      )
    } catch (err) {
      setResult({
        ok: false,
        latencyMs: 0,
        error: err instanceof Error ? err.message : String(err),
        model: model.trim(),
      })
    } finally {
      setRunning(false)
    }
  }, [canRun, providerId, effectiveKey, model, probeText, probeMaxTokens])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      void runTest()
    }
  }

  return (
    <div className={`latency-page${embedded ? ' latency-embedded' : ''}`}>
      {!embedded && (
        <header className="page-top">
          <button className="page-back" onClick={onBack}>
            ← 返回
          </button>
          <div className="page-top-title">
            <h2>测延迟设置</h2>
            <p>这里的文本 / 模型 / max_tokens 会用于仪表盘每一次延迟探测</p>
          </div>
        </header>
      )}

      <div className="latency-grid">
        <div className="latency-form card">
          <div className="settings-section-title" style={{ marginTop: 0 }}>
            探测参数
          </div>

          <div className="form-grid">
            <div className="form-group form-group-full">
              <label>探测文本 *</label>
              <textarea
                className="form-textarea latency-text"
                value={probeText}
                onChange={(e) => setProbeText(e.target.value)}
                rows={4}
                placeholder="每次延迟探测发送的用户消息…"
              />
              <div className="latency-hint">
                默认「请用一句话介绍你自己。」——比固定 Hi 更接近真实调用
              </div>
            </div>

            <div className="form-group">
              <label>max_tokens</label>
              <input
                className="form-input"
                type="number"
                min={1}
                max={4096}
                value={probeMaxTokens}
                onChange={(e) => setProbeMaxTokens(Math.max(1, Number(e.target.value) || 64))}
              />
              <div className="latency-hint">建议 ≤ 64，探测更快也更省 token</div>
            </div>

            <div className="form-group">
              <label>模型覆盖（可选）</label>
              <input
                className="form-input"
                value={probeModel}
                onChange={(e) => setProbeModel(e.target.value)}
                placeholder="留空 = 各厂商默认模型"
              />
              <div className="latency-hint">
                填了会强制所有厂商用这个模型名；只监控一家时才建议填
              </div>
            </div>
          </div>

          <hr className="latency-divider" />

          <div className="settings-section-title">立即测试</div>

          <div className="form-grid">
            <div className="form-group">
              <label>供应商 *</label>
              {availableProviders.length === 0 && !useCustomKey ? (
                <div className="latency-hint">
                  还没有已导入密钥的供应商。先去「密钥管理」导入，或勾选下方手动粘贴 Key。
                </div>
              ) : (
                <select
                  className="form-select"
                  value={providerId}
                  onChange={(e) => setProviderId(e.target.value)}
                >
                  <option value="">选择供应商…</option>
                  {(useCustomKey ? providers : availableProviders).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {(keys[p.id] ?? []).length > 0 ? `（${(keys[p.id] ?? []).length} key）` : ''}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="form-group">
              <label>测试模型</label>
              <input
                className="form-input"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="默认用上方「模型覆盖」或厂商默认"
                autoComplete="off"
              />
            </div>

            <div className="form-group form-group-full">
              <label>API Key *</label>
              <label className="latency-check">
                <input
                  type="checkbox"
                  checked={useCustomKey}
                  onChange={(e) => setUseCustomKey(e.target.checked)}
                />
                手动粘贴 Key（不使用已导入密钥）
              </label>
              {useCustomKey ? (
                <>
                  <div className="latency-hint" style={{ marginBottom: 6 }}>
                    手动粘贴模式下仍需选择一个供应商以确定接口地址与协议。
                  </div>
                  <select
                    className="form-select"
                    value={providerId}
                    onChange={(e) => setProviderId(e.target.value)}
                  >
                    <option value="">选择供应商…</option>
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                        {(keys[p.id] ?? []).length > 0 ? `（${(keys[p.id] ?? []).length} key）` : ''}
                      </option>
                    ))}
                  </select>
                  <input
                    className="form-input"
                    type="password"
                    value={customKey}
                    onChange={(e) => setCustomKey(e.target.value)}
                    placeholder="sk-..."
                    autoComplete="off"
                    style={{ marginTop: 8 }}
                  />
                </>
              ) : providerKeys.length === 0 || !providerId ? (
                <div className="latency-hint">
                  该供应商暂无已导入密钥，请先去「密钥管理」导入，或勾选上方手动粘贴。
                </div>
              ) : (
                <select
                  className="form-select"
                  value={keyIndex}
                  onChange={(e) => setKeyIndex(Number(e.target.value))}
                >
                  {providerKeys.map((k, i) => (
                    <option key={k} value={i}>
                      {keyLabels[k] ? `${keyLabels[k]} · ` : ''}
                      {maskKey(k)}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="form-group form-group-full">
              <label>
                模型列表
                <span className="latency-model-meta">
                  {modelsLoading
                    ? '拉取中…'
                    : apiModels.length > 0
                      ? `接口返回 ${apiModels.length} 个`
                      : modelsError
                        ? '使用内置列表'
                        : builtinModels.length > 0
                          ? `内置 ${builtinModels.length} 个`
                          : ''}
                </span>
              </label>
              <div className="latency-model-bar">
                <input
                  className="form-input"
                  value={modelFilter}
                  onChange={(e) => setModelFilter(e.target.value)}
                  placeholder="过滤模型名…"
                />
                <button
                  type="button"
                  className="btn-secondary set-chip"
                  onClick={refreshModels}
                  disabled={modelsLoading || !effectiveKey}
                  title="从接口重新拉取全部模型"
                >
                  {modelsLoading ? '…' : '↻ 刷新'}
                </button>
              </div>
              {modelsError && !modelsLoading && apiModels.length === 0 && (
                <div className="latency-hint latency-warn">
                  模型列表拉取失败：{modelsError}。下方为内置列表，也可手动输入。
                </div>
              )}
              <div className="latency-model-list" role="listbox" aria-label="模型列表">
                {visibleModels.length === 0 ? (
                  <div className="latency-model-empty">
                    {allModelIds.length === 0
                      ? '暂无模型。输入 API Key 后自动拉取，或手动输入模型名。'
                      : '没有匹配的模型'}
                  </div>
                ) : (
                  visibleModels.map((m) => (
                    <button
                      key={m}
                      type="button"
                      role="option"
                      aria-selected={model === m}
                      className={`latency-model-item ${model === m ? 'active' : ''}`}
                      onClick={() => setModel(m)}
                      title={m}
                    >
                      <span className="lm-check">{model === m ? '✓' : ''}</span>
                      <span className="lm-name">{m}</span>
                      {!apiModels.includes(m) && <span className="lm-tag">内置</span>}
                    </button>
                  ))
                )}
              </div>
            </div>

            <div className="form-group latency-actions">
              <button
                className="btn btn-start latency-save"
                onClick={() => void saveSettings()}
                disabled={saving}
              >
                {saving ? '保存中…' : savedAt ? '✓ 已保存' : '保存测延迟设置'}
              </button>
              <button
                className="btn btn-start latency-run"
                onClick={() => void runTest()}
                disabled={!canRun}
              >
                {running ? '⏳ 发送中…' : '⚡ 立即测试'}
              </button>
            </div>
          </div>

          {result && (
            <div className={`latency-result ${result.ok ? 'ok' : 'fail'}`}>
              <div className="latency-result-head">
                <span className={`latency-big ${result.ok ? latencyClass(result.latencyMs) : 'bad'}`}>
                  {formatMs(result.latencyMs)}
                </span>
                <span className={`latency-badge ${result.ok ? 'ok' : 'fail'}`}>
                  {result.ok
                    ? `成功${result.status ? ` · HTTP ${result.status}` : ''}`
                    : result.error || '失败'}
                </span>
                {result.usage?.total_tokens != null && (
                  <span className="latency-tokens">{result.usage.total_tokens} tokens</span>
                )}
                {result.ok && (
                  <span className="latency-tokens">已写回仪表盘延迟</span>
                )}
              </div>
              {result.text && <pre className="latency-response">{result.text}</pre>}
            </div>
          )}
        </div>

        <div className="latency-side">
          <div className="card latency-history">
            <h3>本次会话记录</h3>
            {history.length === 0 ? (
              <p className="latency-empty">尚无测试记录</p>
            ) : (
              <ul>
                {history.map((h) => (
                  <li key={h.id} className={h.ok ? 'ok' : 'fail'}>
                    <span className={`lh-ms ${h.ok ? latencyClass(h.latencyMs) : 'bad'}`}>
                      {formatMs(h.latencyMs)}
                    </span>
                    <span className="lh-model">{h.model}</span>
                    <span className="lh-time">{h.at}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card latency-history">
            <h3>生效说明</h3>
            <p className="latency-empty" style={{ lineHeight: 1.7 }}>
              保存「探测参数」后：
              <br />
              · 仪表盘自动轮询用该文本/模型/max_tokens
              <br />
              · 「立即检测」同样用这套参数
              <br />
              · 测试结果会更新对应密钥的延迟显示
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
