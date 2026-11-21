import { useState, useRef, useCallback, useEffect } from 'react'
import type { Provider } from '../preload'

interface Props {
  providers: Provider[]
  keys: Record<string, string[]>
  labels: Record<string, string>
  onKeysChange: (keys: Record<string, string[]>) => Promise<void>
}

interface UnknownKey {
  key: string
  providerId: string
}

function detectProviderFromKey(key: string, providers: Provider[]): string | null {
  const trimmed = key.trim()
  if (!trimmed) return null
  if (trimmed.includes('|')) {
    const [prefix] = trimmed.split('|', 2)
    const match = providers.find(
      (p) =>
        p.id === prefix.toLowerCase() ||
        p.name.toLowerCase().includes(prefix.toLowerCase()) ||
        p.baseUrl.includes(prefix)
    )
    if (match) return match.id
  }
  if (trimmed.startsWith('sk-ant-')) return 'anthropic'
  return null
}

function parseKeysFromText(text: string): string[] {
  return text
    .split(/[\r\n,]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 5 && !line.startsWith('#'))
}

function maskKey(key: string): string {
  if (key.length <= 12) return key
  return `${key.slice(0, 6)}••••${key.slice(-4)}`
}

/**
 * 按文件真实编码读文本。导入清单经常来自 Excel/WPS，默认存成 GBK，
 * 而 file.text() 一律当 UTF-8 解——中文标注就会变成「灏忕背」这种乱码，
 * 连厂商名都匹配不上。这里先认 BOM，再试严格 UTF-8，最后回退 GBK。
 */
async function readTextFile(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3))
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('gbk').decode(bytes)
  }
}

export default function KeyManager({ providers, keys, labels, onKeysChange }: Props) {
  const [bulkText, setBulkText] = useState('')
  const [bulkProvider, setBulkProvider] = useState('')
  const [msg, setMsg] = useState('')
  const [detecting, setDetecting] = useState(false)
  const [unknownKeys, setUnknownKeys] = useState<UnknownKey[]>([])
  const [bulkAssign, setBulkAssign] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleBulkImport = useCallback(async () => {
    const rawLines = bulkText.trim()
    if (!rawLines) return
    const lines = parseKeysFromText(rawLines)
    const newKeys: Record<string, string[]> = { ...keys }
    const failedKeys: string[] = []

    setDetecting(true)
    setMsg('正在智能识别密钥归属厂商...')

    const results = await Promise.all(
      lines.map(async (line) => {
        const formatDetected = detectProviderFromKey(line, providers)
        const key = line.includes('|') ? line.split('|')[1].trim() : line.trim()

        if (formatDetected) return { providerId: formatDetected, key }
        if (bulkProvider) return { providerId: bulkProvider, key }

        const apiDetected = await window.electronAPI.detectKey(key)
        return { providerId: apiDetected, key }
      })
    )

    setDetecting(false)

    // Only count keys that are actually NEW this round — the summary used to
    // count every loaded key, so importing 1 key next to an existing one
    // reported "已识别 2 个密钥".
    const added: Record<string, string[]> = {}
    for (const { providerId, key } of results) {
      if (providerId) {
        if (!newKeys[providerId]) newKeys[providerId] = []
        if (!newKeys[providerId].includes(key)) {
          newKeys[providerId].push(key)
          if (!added[providerId]) added[providerId] = []
          added[providerId].push(key)
        }
      } else {
        failedKeys.push(key)
      }
    }

    await onKeysChange(newKeys)

    const count = Object.values(added).reduce((sum, ks) => sum + ks.length, 0)
    const detail = Object.entries(added)
      .map(([pid, ks]) => `${providers.find((x) => x.id === pid)?.name ?? pid} ${ks.length} 个`)
      .join('，')

    let summary = count > 0 ? `已识别 ${count} 个密钥（${detail}）` : '没有新增密钥（可能已存在）'
    if (failedKeys.length > 0) {
      summary += summary ? '；' : ''
      summary += `${failedKeys.length} 个未识别，请手动指定`
      setUnknownKeys(failedKeys.map((k) => ({ key: k, providerId: '' })))
    }

    setMsg(summary)
    setBulkText('')
    setTimeout(() => setMsg(''), 6000)
  }, [bulkText, bulkProvider, providers, keys, onKeysChange])

  const confirmUnknownKeys = useCallback(async () => {
    const newKeys: Record<string, string[]> = { ...keys }
    for (const uk of unknownKeys) {
      const pid = uk.providerId || bulkAssign
      if (pid) {
        if (!newKeys[pid]) newKeys[pid] = []
        if (!newKeys[pid].includes(uk.key)) newKeys[pid].push(uk.key)
      }
    }
    await onKeysChange(newKeys)
    const assignedCount = unknownKeys.filter((uk) => uk.providerId || bulkAssign).length
    setMsg(`已手动分配 ${assignedCount} 个密钥`)
    setUnknownKeys([])
    setBulkAssign('')
    setTimeout(() => setMsg(''), 4000)
  }, [unknownKeys, bulkAssign, keys, onKeysChange])

  const cancelUnknownKeys = useCallback(() => {
    setUnknownKeys([])
    setBulkAssign('')
  }, [])

  // 「无法识别密钥」的分配弹窗：ESC 等同于点 × 取消（否则键盘用户只能去点按钮）。
  useEffect(() => {
    if (unknownKeys.length === 0) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelUnknownKeys()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [unknownKeys.length, cancelUnknownKeys])

  async function handleFileImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const text = await readTextFile(file)
    try {
      if (file.name.endsWith('.json')) {
        const data = JSON.parse(text) as Array<Record<string, string>>
        const entries: Array<{ baseUrl: string; key: string }> = []
        for (const item of Array.isArray(data) ? data : [data]) {
          // 只有带了 baseUrl 才按 baseUrl 做模糊匹配。以前写成
          // `p.baseUrl.includes(item.baseUrl || '')`，item.baseUrl 为空时是
          // includes('')，恒为 true —— 任何没写 baseUrl 的条目都会被塞进数组第一家
          // （PROVIDERS[0]），provider 字段写对了也白写。
          const wantedId = (item.provider ?? '').toLowerCase()
          const byId = providers.find(
            (p) => p.id === item.provider || p.name.toLowerCase() === wantedId
          )
          const provider = byId ?? (item.baseUrl ? providers.find((p) => p.baseUrl.includes(item.baseUrl)) : undefined)
          const baseUrl = provider?.baseUrl || item.baseUrl || ''
          const key = item.key || item.api_key || item.apiKey || item.token || ''
          if (baseUrl && key) entries.push({ baseUrl, key })
        }
        const matched = await window.electronAPI.importCustom(entries)
        const newKeys: Record<string, string[]> = { ...keys }
        for (const m of matched) {
          if (!newKeys[m.providerId]) newKeys[m.providerId] = []
          if (!newKeys[m.providerId].includes(m.key)) newKeys[m.providerId].push(m.key)
        }
        await onKeysChange(newKeys)
        setMsg(`从 ${file.name} 成功导入 ${entries.length} 个密钥`)
      } else if (file.name.endsWith('.csv') || file.name.endsWith('.txt')) {
        // 按行切，再解析每行的「厂商,密钥」/「厂商|密钥」/全角逗号。
        // 以前这里复用 parseKeysFromText —— 它内部按 /[\r\n,]+/ 切分，逗号在切行时
        // 就被吃掉了，于是每行都不再包含分隔符，CSV 导入恒为 0 条却提示「成功导入」。
        const rawLines = text
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && !l.startsWith('#'))
        const entries: Array<{ baseUrl: string; key: string }> = []
        for (const line of rawLines) {
          const parts = line.split(/[,|，\t]/).map((s) => s.trim())
          if (parts.length < 2) continue
          const [a, b] = parts
          if (!a || !b) continue
          const provider = providers.find(
            (p) =>
              p.id === a.toLowerCase() ||
              p.name.toLowerCase() === a.toLowerCase() ||
              p.baseUrl.includes(a)
          )
          const baseUrl = provider?.baseUrl || (a.includes('://') ? a : '')
          if (!baseUrl) continue
          entries.push({ baseUrl, key: b })
        }
        const matched = await window.electronAPI.importCustom(entries)
        const newKeys: Record<string, string[]> = { ...keys }
        for (const m of matched) {
          if (!newKeys[m.providerId]) newKeys[m.providerId] = []
          if (!newKeys[m.providerId].includes(m.key)) newKeys[m.providerId].push(m.key)
        }
        await onKeysChange(newKeys)
        setMsg(
          entries.length > 0
            ? `从 ${file.name} 成功导入 ${entries.length} 个密钥`
            : `没有从 ${file.name} 解析出密钥：每行格式应为「厂商,密钥」或「厂商|密钥」`
        )
      }
    } catch (err) {
      setMsg('文件解析失败：' + (err instanceof Error ? err.message : String(err)))
    }
    if (fileInputRef.current) fileInputRef.current.value = ''
    setTimeout(() => setMsg(''), 4000)
  }

  async function handleRemoveKey(providerId: string, keyIndex: number) {
    const newKeys = { ...keys }
    const providerKeys = [...(newKeys[providerId] || [])]
    providerKeys.splice(keyIndex, 1)
    if (providerKeys.length === 0) {
      delete newKeys[providerId]
    } else {
      newKeys[providerId] = providerKeys
    }
    // Single write: setKeys persists the full map AND syncs the monitor
    // engine (including stopping providers whose keys were all removed).
    // Calling removeApiKey on top of this deleted a second key by index.
    await onKeysChange(newKeys)
  }

  return (
    <div className="key-manager">
      <div className="key-section">
        <h2>批量导入密钥</h2>
        <p>每行一个密钥，或格式：厂商名 | 密钥（如 deepseek|sk-xxxx）</p>
        <div className="import-box">
          <h3>粘贴导入</h3>
          <div className="textarea-wrap">
            <textarea
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              placeholder={'sk-xxxx1\nsk-xxxx2\ndeepseek|sk-xxxx3\nopenai|sk-xxxx4'}
            />
          </div>
          <div className="btn-group">
            <select
              className="interval-select"
              value={bulkProvider}
              onChange={(e) => setBulkProvider(e.target.value)}
              style={{ minWidth: 150 }}
            >
              <option value="">自动识别厂商</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              className="btn btn-start"
              onClick={handleBulkImport}
              disabled={!bulkText.trim() || detecting}
            >
              {detecting ? '⏳ 识别中...' : '导入密钥'}
            </button>
          </div>
        </div>
        <div className="import-box">
          <h3>文件导入</h3>
          <p style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 12 }}>
            支持 JSON（数组格式，字段：provider/baseUrl + key/api_key）和 CSV（格式：厂商，密钥）
          </p>
          <label className="file-label">
            选择文件
            <input
              ref={fileInputRef}
              type="file"
              className="file-input"
              accept=".json,.csv,.txt"
              onChange={handleFileImport}
            />
          </label>
        </div>
        {msg && (
          <div className={msg.includes('未识别') || msg.includes('失败') ? 'error-msg' : 'success-msg'}>
            {msg}
          </div>
        )}
      </div>

      <div className="key-section">
        <h2>已加载密钥</h2>
        {Object.keys(keys).every((k) => !keys[k] || keys[k].length === 0) ? (
          <p style={{ color: 'var(--text-muted)', fontSize: 13, padding: '20px 0' }}>
            尚无任何密钥。请在上方添加。
          </p>
        ) : (
          <div className="key-list">
            {Object.entries(keys)
              .filter(([, ks]) => ks && ks.length > 0)
              .map(([pid, ks]) => {
                const provider = providers.find((p) => p.id === pid)
                if (!provider) return null
                return (
                  <div key={pid} className="key-item">
                    <div className="key-item-head">
                      <div className="key-item-info">
                        <span className="key-item-provider">{provider.name}</span>
                        <span className="key-item-hint">{provider.baseUrl}</span>
                      </div>
                      <span className="key-count">{ks.length} 个密钥</span>
                    </div>
                    <div className="key-chip-list">
                      {ks.map((k, i) => (
                        <span key={i} className="key-chip">
                          {labels[k] && <b className="key-chip-label">{labels[k]}</b>}
                          {maskKey(k)}
                          <button
                            className="key-chip-copy"
                            onClick={() => {
                              void window.electronAPI.copyText(k)
                              setMsg('已复制密钥')
                              setTimeout(() => setMsg(''), 1500)
                            }}
                            title="复制完整密钥"
                          >
                            ⧉
                          </button>
                          <button
                            className="key-chip-remove"
                            onClick={() => handleRemoveKey(pid, i)}
                            title="移除"
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                )
              })}
          </div>
        )}
      </div>

      {unknownKeys.length > 0 && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-header">
              <h3>以下密钥无法识别，请手动指定厂商</h3>
              <button className="modal-close" onClick={cancelUnknownKeys}>×</button>
            </div>
            <div className="modal-body">
              <div className="bulk-assign-row">
                <span>全部分配到:</span>
                <select
                  className="interval-select"
                  value={bulkAssign}
                  onChange={(e) => {
                    setBulkAssign(e.target.value)
                    setUnknownKeys((prev) =>
                      prev.map((uk) => ({ ...uk, providerId: e.target.value }))
                    )
                  }}
                  style={{ flex: 1 }}
                >
                  <option value="">逐个选择</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
              <div className="unknown-key-list">
                {unknownKeys.map((uk, i) => (
                  <div key={i} className="unknown-key-row">
                    <span className="unknown-key">{maskKey(uk.key)}</span>
                    <select
                      className="interval-select"
                      value={uk.providerId}
                      onChange={(e) =>
                        setUnknownKeys((prev) =>
                          prev.map((x, xi) => (xi === i ? { ...x, providerId: e.target.value } : x))
                        )
                      }
                    >
                      <option value="">选择厂商</option>
                      {providers.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={cancelUnknownKeys}>取消</button>
              <button
                className="btn btn-start"
                onClick={confirmUnknownKeys}
                disabled={unknownKeys.some((uk) => !uk.providerId && !bulkAssign)}
              >
                确认分配
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
