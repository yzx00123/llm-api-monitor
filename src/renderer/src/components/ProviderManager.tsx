import { useState, useEffect, useCallback } from 'react'
import type { Provider } from '../preload'

interface Props {
  providers: Provider[]
  onProvidersChange: (providers: Provider[]) => void
  onBack: () => void
}

interface FormState {
  slug: string
  name: string
  note: string
  website: string
  baseUrl: string
  balanceUrl: string
  apiKey: string
  protocol: 'openai' | 'anthropic' | 'gemini'
  category: 'international' | 'china' | 'aggregator' | 'custom'
  models: string[]
}

const EMPTY: FormState = {
  slug: '',
  name: '',
  note: '',
  website: '',
  baseUrl: '',
  balanceUrl: '',
  apiKey: '',
  protocol: 'openai',
  category: 'custom',
  models: [],
}

const PROTOCOL_LABEL: Record<string, string> = {
  openai: 'OpenAI Completions',
  anthropic: 'Anthropic Messages',
  gemini: 'Gemini generateContent',
}

export default function ProviderManager({ providers, onProvidersChange, onBack }: Props) {
  const [mode, setMode] = useState<'list' | 'form'>('list')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY)
  const [modelDraft, setModelDraft] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const customProviders = providers.filter((p) => p.category === 'custom')
  const builtInProviders = providers.filter((p) => p.category !== 'custom')

  const flash = useCallback((m: string) => {
    setMsg(m)
    setTimeout(() => setMsg(''), 3500)
  }, [])

  const openCreate = useCallback(() => {
    setForm(EMPTY)
    setEditingId(null)
    setModelDraft('')
    setMode('form')
  }, [])

  const openEdit = useCallback((p: Provider) => {
    setForm({
      slug: p.id.startsWith('custom-') ? '' : p.id,
      name: p.name,
      note: p.note ?? p.company ?? '',
      website: p.website ?? '',
      baseUrl: p.baseUrl,
      balanceUrl: p.balanceUrl ?? '',
      apiKey: '',
      protocol: (p.protocol as FormState['protocol']) ?? 'openai',
      category: (p.category as FormState['category']) ?? 'custom',
      models: [...(p.models ?? [])],
    })
    setEditingId(p.id)
    setModelDraft('')
    setMode('form')
  }, [])

  const cancelForm = useCallback(() => {
    setMode('list')
    setEditingId(null)
    setForm(EMPTY)
    setMsg('')
  }, [])

  const configJson = JSON.stringify(
    {
      baseUrl: form.baseUrl,
      apiKey: form.apiKey ? '••••' : '',
      api: form.protocol === 'openai' ? 'openai-completions' : form.protocol,
      models: form.models,
    },
    null,
    2
  )

  const addModel = useCallback(() => {
    const m = modelDraft.trim()
    if (!m) return
    setForm((f) => (f.models.includes(m) ? f : { ...f, models: [...f.models, m] }))
    setModelDraft('')
  }, [modelDraft])

  const removeModel = useCallback((m: string) => {
    setForm((f) => ({ ...f, models: f.models.filter((x) => x !== m) }))
  }, [])

  const handleSave = useCallback(async () => {
    if (!form.name.trim() || !form.baseUrl.trim()) {
      flash('请填写名称和 API 端点')
      return
    }
    // 端点必须是合法的 http(s) URL。以前只是 trim 后落库，写成 `api.example.com/v1`
    // 也能保存，之后每次探测都失败、卡片显示英文的 "Failed to parse URL from …"，
    // 用户根本看不出是地址格式问题。顺手补上协议、去掉末尾斜杠。
    const normalizeUrl = (raw: string): string | null => {
      const t = raw.trim()
      if (!t) return null
      const withProto = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`
      try {
        const u = new URL(withProto)
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
        return withProto.replace(/\/+$/, '')
      } catch {
        return null
      }
    }
    const baseUrl = normalizeUrl(form.baseUrl)
    if (!baseUrl) {
      flash('API 端点格式不对：需要 http(s) 地址，例如 https://api.example.com/v1')
      return
    }
    const balanceUrl = form.balanceUrl.trim() ? normalizeUrl(form.balanceUrl) : undefined
    if (form.balanceUrl.trim() && !balanceUrl) {
      flash('余额接口地址格式不对：需要 http(s) 地址')
      return
    }
    const rawSlug = form.slug.trim().toLowerCase()
    const slug = rawSlug
      ? rawSlug.replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
      : `custom-${Date.now()}`
    if (rawSlug && !/^[a-z0-9][a-z0-9-_]*$/.test(slug)) {
      flash('供应商标识只能包含小写字母、数字和连字符')
      return
    }
    if (!editingId && providers.some((p) => p.id === slug)) {
      flash('该供应商标识已存在')
      return
    }

    setBusy(true)
    try {
      const payload = {
        id: editingId ?? slug,
        name: form.name.trim(),
        company: form.note.trim(),
        note: form.note.trim(),
        website: form.website.trim(),
        baseUrl,
        balanceUrl,
        protocol: form.protocol,
        // 自定义供应商的类别必须是 'custom'：以前编辑时允许改成「国内厂商」，保存后
        // 它就从「自定义供应商」区消失、被当成内置供应商渲染成只读卡片，再也无法
        // 编辑或删除（只能手改配置文件）。
        category: 'custom' as const,
        models: form.models,
      }

      if (editingId) {
        await window.electronAPI.updateCustomProvider(editingId, payload)
      } else {
        await window.electronAPI.addCustomProvider(payload)
        if (form.apiKey.trim()) {
          await window.electronAPI.addApiKey(payload.id, [form.apiKey.trim()])
        }
      }

      const all = await window.electronAPI.getProviders()
      onProvidersChange(all)
      flash(editingId ? '已更新供应商' : '已添加供应商')
      setMode('list')
      setEditingId(null)
      setForm(EMPTY)
    } catch (err) {
      flash('操作失败：' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setBusy(false)
    }
  }, [form, editingId, providers, flash, onProvidersChange])

  const handleDelete = useCallback(
    async (id: string) => {
      if (!confirm('确定删除此供应商？将同时删除相关密钥。')) return
      try {
        await window.electronAPI.deleteCustomProvider(id)
        const all = await window.electronAPI.getProviders()
        onProvidersChange(all)
        flash('已删除供应商')
      } catch (err) {
        flash('删除失败：' + (err instanceof Error ? err.message : String(err)))
      }
    },
    [flash, onProvidersChange]
  )

  // ── Full-page form (CC Switch style) ──────────────────────────
  if (mode === 'form') {
    return (
      <div className="provider-form-page">
        <header className="page-top">
          <button className="page-back" onClick={cancelForm}>
            ← 返回
          </button>
          <div className="page-top-title">
            <h2>{editingId ? '编辑供应商' : '添加供应商'}</h2>
            <p>自定义配置 · 手动填写所有字段</p>
          </div>
        </header>

        <div className="provider-form card">
          <div className="pf-banner">
            <span className="pf-banner-icon">☰</span>
            <span>自定义配置 · 手动填写所有字段</span>
            <span className="pf-banner-tag">{editingId ? '编辑中' : '新建'}</span>
          </div>

          <div className="form-grid">
            <div className="form-group form-group-full">
              <label>
                供应商标识 <em>*</em>
              </label>
              <input
                className="form-input"
                value={form.slug}
                onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))}
                placeholder="my-provider"
                disabled={!!editingId}
                autoComplete="off"
              />
              <div className="pf-help">配置文件中的唯一标识符，只能使用小写字母、数字和连字符</div>
            </div>

            <div className="form-group">
              <label>
                名称 <em>*</em>
              </label>
              <input
                className="form-input"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="例如：Claude 官方"
              />
            </div>

            <div className="form-group">
              <label>备注</label>
              <input
                className="form-input"
                value={form.note}
                onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
                placeholder="例如：公司专用账号"
              />
            </div>

            <div className="form-group form-group-full">
              <label>官网链接</label>
              <input
                className="form-input"
                value={form.website}
                onChange={(e) => setForm((f) => ({ ...f, website: e.target.value }))}
                placeholder="https://example.com（可选）"
              />
            </div>

            <div className="form-group form-group-full">
              <label>API 协议</label>
              <select
                className="form-select"
                value={form.protocol}
                onChange={(e) =>
                  setForm((f) => ({ ...f, protocol: e.target.value as FormState['protocol'] }))
                }
              >
                <option value="openai">{PROTOCOL_LABEL.openai}</option>
                <option value="anthropic">{PROTOCOL_LABEL.anthropic}</option>
                <option value="gemini">{PROTOCOL_LABEL.gemini}</option>
              </select>
              <div className="pf-help">选择与供应商 API 兼容的协议类型。大多数供应商使用 OpenAI Completions 格式。</div>
            </div>

            <div className="form-group form-group-full">
              <label>
                API 端点 <em>*</em>
              </label>
              <input
                className="form-input"
                value={form.baseUrl}
                onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
                placeholder="https://api.example.com/v1"
              />
            </div>

            <div className="form-group form-group-full">
              <label>余额查询地址</label>
              <input
                className="form-input"
                value={form.balanceUrl}
                onChange={(e) => setForm((f) => ({ ...f, balanceUrl: e.target.value }))}
                placeholder="https://api.example.com/balance（可选）"
              />
            </div>

            <div className="form-group form-group-full">
              <label>API Key</label>
              <input
                className="form-input"
                type="password"
                value={form.apiKey}
                onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
                placeholder="只需要填这里，保存后会自动加入密钥列表"
                autoComplete="off"
              />
            </div>

            <div className="form-group">
              <label>类别</label>
              <select
                className="form-select"
                value={form.category}
                onChange={(e) =>
                  setForm((f) => ({ ...f, category: e.target.value as FormState['category'] }))
                }
              >
                <option value="custom">自定义</option>
                <option value="international">国际厂商</option>
                <option value="china">国内厂商</option>
                <option value="aggregator">聚合平台</option>
              </select>
            </div>

            <div className="form-group form-group-full">
              <label>模型配置</label>
              <div className="pf-models">
                <div className="pf-models-actions">
                  <button type="button" className="btn-secondary set-chip" onClick={addModel}>
                    + 添加模型
                  </button>
                </div>
                {form.models.length === 0 ? (
                  <div className="pf-models-empty">暂无模型配置</div>
                ) : (
                  <div className="pf-model-tags">
                    {form.models.map((m) => (
                      <span key={m} className="pf-model-tag">
                        {m}
                        <button type="button" onClick={() => removeModel(m)} title="移除">
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="pf-model-add-row">
                  <input
                    className="form-input"
                    value={modelDraft}
                    onChange={(e) => setModelDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        addModel()
                      }
                    }}
                    placeholder="model-id，回车添加"
                  />
                </div>
              </div>
            </div>

            <div className="form-group form-group-full">
              <label>配置 JSON</label>
              <pre className="pf-json">{configJson}</pre>
            </div>
          </div>

          {msg && (
            <div className={msg.includes('失败') ? 'error-msg' : 'success-msg'}>{msg}</div>
          )}

          <div className="provider-form-footer">
            <button className="btn-secondary" onClick={cancelForm}>
              取消
            </button>
            <button
              className="btn btn-start"
              onClick={() => void handleSave()}
              disabled={busy || !form.name.trim() || !form.baseUrl.trim()}
            >
              {busy ? '保存中…' : editingId ? '保存' : '添加'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── List ──────────────────────────────────────────────────────
  return (
    <div className="provider-manager">
      <header className="page-top">
        <button className="page-back" onClick={onBack}>
          ← 返回
        </button>
        <div className="page-top-title">
          <h2>供应商</h2>
          <p>内置 {builtInProviders.length} 家 · 自定义 {customProviders.length} 家</p>
        </div>
        <div className="page-top-actions">
          <button className="btn btn-start" onClick={openCreate}>
            + 添加供应商
          </button>
        </div>
      </header>

      {msg && (
        <div className={msg.includes('失败') ? 'error-msg' : 'success-msg'} style={{ marginBottom: 14 }}>
          {msg}
        </div>
      )}

      <div className="pm-section">
        <h3>内置供应商 ({builtInProviders.length})</h3>
        <div className="grid grid-providers">
          {builtInProviders.map((p) => (
            <div key={p.id} className="card card-provider builtin">
              <div className="card-provider-head">
                <span className="card-provider-name">{p.name}</span>
                <span
                  className={`status-dot ${
                    p.category === 'international'
                      ? 'blue'
                      : p.category === 'china'
                        ? 'green'
                        : 'purple'
                  }`}
                />
              </div>
              <div className="card-provider-body">
                <div className="field">
                  <label>公司</label>
                  <span>{p.company}</span>
                </div>
                <div className="field">
                  <label>协议</label>
                  <span>{p.protocol}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="pm-section">
        <h3>自定义供应商 ({customProviders.length})</h3>
        {customProviders.length === 0 ? (
          <div className="pm-empty">
            <p>尚无自定义供应商</p>
            <button className="btn btn-start" onClick={openCreate}>
              + 添加供应商
            </button>
          </div>
        ) : (
          <div className="grid grid-providers">
            {customProviders.map((p) => (
              <div key={p.id} className="card card-provider custom">
                <div className="card-provider-head">
                  <span className="card-provider-name">{p.name}</span>
                  <div className="card-provider-actions">
                    <button className="btn-icon" onClick={() => openEdit(p)} title="编辑">
                      ✎
                    </button>
                    <button
                      className="btn-icon btn-danger"
                      onClick={() => void handleDelete(p.id)}
                      title="删除"
                    >
                      ×
                    </button>
                  </div>
                </div>
                <div className="card-provider-body">
                  <div className="field">
                    <label>标识</label>
                    <span className="mono">{p.id}</span>
                  </div>
                  <div className="field">
                    <label>协议</label>
                    <span>{p.protocol}</span>
                  </div>
                  <div className="field field-full">
                    <label>端点</label>
                    <span className="mono ellipsis">{p.baseUrl}</span>
                  </div>
                  {p.note && (
                    <div className="field field-full">
                      <label>备注</label>
                      <span>{p.note}</span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
