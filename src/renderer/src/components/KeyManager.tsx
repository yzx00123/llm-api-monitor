import { useState, useRef, useCallback, useEffect } from 'react'
import type { Provider } from '../preload'
import { parseKeyFile, decodeTextBytes, SUPPORTED_KEY_FILE_EXTS } from '../lib/parseKeyFile'

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
 * 按文件真实编码读文本。编码判定在 lib/parseKeyFile.ts 的 decodeTextBytes（可直接测）。
 */
async function readTextFile(file: File): Promise<string> {
  return decodeTextBytes(new Uint8Array(await file.arrayBuffer()))
}

export default function KeyManager({ providers, keys, labels, onKeysChange }: Props) {
  const [bulkText, setBulkText] = useState('')
  const [bulkProvider, setBulkProvider] = useState('')
  const [msg, setMsg] = useState('')
  const [detecting, setDetecting] = useState(false)
  const [unknownKeys, setUnknownKeys] = useState<UnknownKey[]>([])
  const [bulkAssign, setBulkAssign] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  // 消息自清计时器：上一次导入的「清空」定时器会把下一次导入的提示提前抹掉
  // （连续导入文件时只看到「成功导入」，后面几次的提示一闪而过），所以统一走 flash。
  const msgTimer = useRef<number | null>(null)
  const flash = useCallback((text: string, ms = 6000) => {
    if (msgTimer.current) window.clearTimeout(msgTimer.current)
    setMsg(text)
    msgTimer.current = window.setTimeout(() => setMsg(''), ms)
  }, [])

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

    flash(summary, 8000)
    setBulkText('')
  }, [bulkText, bulkProvider, providers, keys, onKeysChange, flash])

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
    flash(`已手动分配 ${assignedCount} 个密钥`, 4000)
    setUnknownKeys([])
    setBulkAssign('')
  }, [unknownKeys, bulkAssign, keys, onKeysChange, flash])

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

  // 文件导入：.json / .csv / .txt
  //
  // 解析逻辑抽到了 lib/parseKeyFile.ts（纯函数，scripts/test-keyfile-import.ts 直接测它），
  // 这里只负责读文件、按扩展名分支、把结果交给主进程落盘并如实提示。
  async function handleFileImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const name = file.name
    const dot = name.lastIndexOf('.')
    const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''

    try {
      if (!SUPPORTED_KEY_FILE_EXTS.includes(ext)) {
        flash(
          '不支持的文件类型「' +
            name +
            '」：请导出为 .json / .csv / .txt 再导入（也可以直接粘贴到上方输入框）',
          8000
        )
        return
      }

      const text = await readTextFile(file)
      const { entries, skipped } = parseKeyFile(text, ext, providers)

      if (entries.length === 0) {
        const hint =
          ext === 'json'
            ? 'JSON 每条记录需要 baseUrl 与 key（或 provider + key，且 provider 是已知厂商）'
            : '每行格式应为「厂商,密钥」或「厂商|密钥」'
        flash('没有从「' + name + '」里解析出密钥：' + hint, 8000)
        return
      }

      const res = await window.electronAPI.importCustom(entries)
      const newKeys: Record<string, string[]> = { ...keys }
      for (const m of res.results) {
        if (!newKeys[m.providerId]) newKeys[m.providerId] = []
        if (!newKeys[m.providerId].includes(m.key)) newKeys[m.providerId].push(m.key)
      }
      await onKeysChange(newKeys)

      // 主进程可能顺手新建了自定义供应商（中转站/自建网关），名字要从最新列表里取
      const allProviders =
        res.createdIds.length > 0 ? await window.electronAPI.getProviders() : providers
      const createdNames = res.createdIds.map(
        (id) => allProviders.find((p) => p.id === id)?.name ?? id
      )
      let summary =
        res.imported > 0
          ? '从「' + name + '」导入 ' + res.imported + ' 个密钥'
          : '「' + name + '」里的密钥都已存在，没有新增'
      if (createdNames.length > 0) {
        summary += '，新建供应商 ' + createdNames.length + ' 个（' + createdNames.join('、') + '）'
      }
      if (skipped > 0) summary += '，跳过 ' + skipped + ' 条无法识别的记录'
      flash(summary, 8000)
    } catch (err) {
      flash('文件解析失败：' + (err instanceof Error ? err.message : String(err)), 8000)
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
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
