import { useState, useEffect, useCallback } from 'react'
import type { Provider } from '../preload'

interface Props {
  providers: Provider[]
  onProvidersChange: (providers: Provider[]) => void
}

interface FormState {
  name: string
  company: string
  baseUrl: string
  balanceUrl: string
  protocol: 'openai' | 'anthropic' | 'gemini'
  models: string
  category: 'international' | 'china' | 'aggregator' | 'custom'
}

export default function ProviderManager({ providers, onProvidersChange }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showAddModal, setShowAddModal] = useState(false)
  const [formData, setFormData] = useState<FormState>({
    name: '',
    company: '',
    baseUrl: '',
    balanceUrl: '',
    protocol: 'openai',
    models: '',
    category: 'custom',
  })
  const [msg, setMsg] = useState('')

  const customProviders = providers.filter((p) => p.category === 'custom')
  const builtInProviders = providers.filter((p) => p.category !== 'custom')

  const resetForm = useCallback(() => {
    setFormData({
      name: '',
      company: '',
      baseUrl: '',
      balanceUrl: '',
      protocol: 'openai',
      models: '',
      category: 'custom',
    })
    setEditingId(null)
    setShowAddModal(false)
  }, [])

  const handleSave = useCallback(async () => {
    if (!formData.name || !formData.baseUrl) {
      setMsg('请填写名称和接口地址')
      setTimeout(() => setMsg(''), 3000)
      return
    }

    try {
      if (editingId) {
        await window.electronAPI.updateCustomProvider(editingId, {
          ...formData,
          models: formData.models.split(',').map((m) => m.trim()).filter((m) => m),
        })
      } else {
        await window.electronAPI.addCustomProvider({
          ...formData,
          id: `custom-${Date.now()}`,
          models: formData.models.split(',').map((m) => m.trim()).filter((m) => m),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
      }
      const all = await window.electronAPI.getProviders()
      onProvidersChange(all)
      resetForm()
      setMsg(editingId ? '已更新供应商' : '已添加供应商')
      setTimeout(() => setMsg(''), 2000)
    } catch (err) {
      setMsg('操作失败：' + (err instanceof Error ? err.message : String(err)))
      setTimeout(() => setMsg(''), 3000)
    }
  }, [formData, editingId, resetForm, onProvidersChange])

  const handleDelete = useCallback(
    async (id: string) => {
      if (!confirm('确定删除此供应商？将同时删除相关密钥。')) return
      try {
        await window.electronAPI.deleteCustomProvider(id)
        const all = await window.electronAPI.getProviders()
        onProvidersChange(all)
        setMsg('已删除供应商')
        setTimeout(() => setMsg(''), 2000)
      } catch (err) {
        setMsg('删除失败：' + (err instanceof Error ? err.message : String(err)))
      }
    },
    [onProvidersChange]
  )

  const handleEdit = useCallback((provider: Provider) => {
    setFormData({
      name: provider.name,
      company: provider.company,
      baseUrl: provider.baseUrl,
      balanceUrl: provider.balanceUrl ?? '',
      protocol: provider.protocol as any,
      models: provider.models.join(', '),
      category: provider.category as any,
    })
    setEditingId(provider.id)
    setShowAddModal(true)
  }, [])

  return (
    <div className="provider-manager">
      <div className="pm-header">
        <h2>供应商管理</h2>
        <button className="btn btn-start" onClick={() => setShowAddModal(true)}>
          + 添加供应商
        </button>
      </div>

      <div className="pm-section">
        <h3>内置供应商 ({builtInProviders.length})</h3>
        <div className="grid grid-providers">
          {builtInProviders.map((p) => (
            <div key={p.id} className="card card-provider builtin">
              <div className="card-provider-head">
                <span className="card-provider-name">{p.name}</span>
                <span className={`status-dot ${p.category === 'international' ? 'blue' : p.category === 'china' ? 'green' : 'purple'}`} />
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
          <p style={{ color: 'var(--text-muted)', fontSize: 13, padding: '40px 0' }}>
            尚无自定义供应商。点击右上角按钮添加。
          </p>
        ) : (
          <div className="grid grid-providers">
            {customProviders.map((p) => (
              <div key={p.id} className="card card-provider custom">
                <div className="card-provider-head">
                  <span className="card-provider-name">{p.name}</span>
                  <div className="card-provider-actions">
                    <button className="btn-icon" onClick={() => handleEdit(p)} title="编辑">✎</button>
                    <button className="btn-icon btn-danger" onClick={() => handleDelete(p.id)} title="删除">×</button>
                  </div>
                </div>
                <div className="card-provider-body">
                  <div className="field">
                    <label>公司</label>
                    <span>{p.company || '—'}</span>
                  </div>
                  <div className="field">
                    <label>协议</label>
                    <span>{p.protocol}</span>
                  </div>
                  {p.balanceUrl && (
                    <div className="field field-full">
                      <label>余额地址</label>
                      <span>{p.balanceUrl}</span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showAddModal && (
        <div className="modal-overlay">
          <div className="modal modal-large">
            <div className="modal-header">
              <h3>{editingId ? '编辑供应商' : '添加供应商'}</h3>
              <button className="modal-close" onClick={resetForm}>×</button>
            </div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="form-group">
                  <label>名称 *</label>
                  <input
                    className="form-input"
                    value={formData.name}
                    onChange={(e) => setFormData((f) => ({ ...f, name: e.target.value }))}
                    placeholder="如：MyPrivateLLM"
                  />
                </div>
                <div className="form-group">
                  <label>公司</label>
                  <input
                    className="form-input"
                    value={formData.company}
                    onChange={(e) => setFormData((f) => ({ ...f, company: e.target.value }))}
                    placeholder="如：私有部署"
                  />
                </div>
                <div className="form-group form-group-full">
                  <label>接口地址 *</label>
                  <input
                    className="form-input"
                    value={formData.baseUrl}
                    onChange={(e) => setFormData((f) => ({ ...f, baseUrl: e.target.value }))}
                    placeholder="https://api.example.com"
                  />
                </div>
                <div className="form-group">
                  <label>协议类型</label>
                  <select
                    className="form-select"
                    value={formData.protocol}
                    onChange={(e) => setFormData((f) => ({ ...f, protocol: e.target.value as any }))}
                  >
                    <option value="openai">OpenAI</option>
                    <option value="anthropic">Anthropic</option>
                    <option value="gemini">Gemini</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>类别</label>
                  <select
                    className="form-select"
                    value={formData.category}
                    onChange={(e) => setFormData((f) => ({ ...f, category: e.target.value as any }))}
                  >
                    <option value="international">国际厂商</option>
                    <option value="china">国内厂商</option>
                    <option value="aggregator">聚合平台</option>
                    <option value="custom">自定义</option>
                  </select>
                </div>
                <div className="form-group form-group-full">
                  <label>余额查询地址（可选）</label>
                  <input
                    className="form-input"
                    value={formData.balanceUrl}
                    onChange={(e) => setFormData((f) => ({ ...f, balanceUrl: e.target.value }))}
                    placeholder="https://api.example.com/balance"
                  />
                </div>
                <div className="form-group form-group-full">
                  <label>默认模型列表（逗号分隔）</label>
                  <textarea
                    className="form-textarea"
                    value={formData.models}
                    onChange={(e) => setFormData((f) => ({ ...f, models: e.target.value }))}
                    placeholder="model-1, model-2, model-3"
                    rows={3}
                  />
                </div>
              </div>
              {msg && (
                <div className={msg.includes('失败') ? 'error-msg' : 'success-msg'}>
                  {msg}
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={resetForm}>取消</button>
              <button className="btn btn-start" onClick={handleSave}>{editingId ? '保存修改' : '添加'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
