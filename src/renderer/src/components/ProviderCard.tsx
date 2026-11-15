import { memo, useState } from 'react'
import type { Provider, ProviderStatus } from '../preload'

interface Props {
  provider: Provider
  keyMask: string
  fullKey: string
  label: string
  keyIndex: number
  status: ProviderStatus | null
  onCheckNow: (id: string, keyIndex: number) => void
  onLabelChange: (key: string, label: string) => Promise<void>
  monitoring: boolean
}

function formatLatency(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function latencyClass(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return ''
  if (ms < 500) return 'good'
  if (ms < 2000) return 'warn'
  return 'bad'
}

function formatBalance(info: ProviderStatus['balanceInfo']): {
  text: string
  broke: boolean
  account: boolean
  tip: string
  shared: boolean
} {
  if (!info) return { text: '', broke: false, account: false, tip: '', shared: false }
  const account = !!info.accountScope
  const tip = account
    ? `控制台账号余额（非本密钥单独余额）${info.accountId ? ` · 账号 ${info.accountId}` : ''}`
    : ''
  // Shared marker: account wallet already painted on another key box.
  if (account && info.available == null) {
    return { text: '同账号', broke: false, account: true, tip, shared: true }
  }
  if (info.available == null) return { text: '', broke: false, account: false, tip: '', shared: false }
  const v = Number(info.available)
  if (v <= 0) return { text: '没钱', broke: true, account, tip, shared: false }
  if (info.currency === 'TOKEN')
    return { text: `${Math.round(v).toLocaleString()} tokens`, broke: false, account, tip, shared: false }
  const prefix = account ? '账号 ' : ''
  return { text: `${prefix}${v.toFixed(2)} ${info.currency}`, broke: false, account, tip, shared: false }
}

function statusLabel(status: string | null): string {
  switch (status) {
    case 'checking': return '检测中'
    case 'online': return '在线'
    case 'offline': return '离线'
    case 'error': return '异常'
    default: return '等待'
  }
}

/**
 * Small box card — one per API key. Name + key mask + status dot on top,
 * latency + balance below. Detail lives in the hover tooltip.
 */
function ProviderCard({ provider, keyMask, fullKey, label, keyIndex, status, onCheckNow, onLabelChange, monitoring }: Props) {
  const s = status
  const statusClass = s?.status ?? 'idle'
  const bal = formatBalance(s?.balanceInfo)
  const [editing, setEditing] = useState(false)
  const [connecting, setConnecting] = useState(false)

  const handleMimoConnect = async () => {
    setConnecting(true)
    try {
      await window.electronAPI.mimoConnect()
    } finally {
      setConnecting(false)
    }
  }
  const tip = [
    statusLabel(s?.status ?? null),
    s?.authStatus === 'valid' ? '认证 ✓' : s?.authStatus === 'invalid' ? '认证 ✗' : '',
    s?.lastChecked ? `上次 ${new Date(s.lastChecked).toLocaleTimeString('zh-CN', { hour12: false })}` : '未检测',
    s?.errorCode ?? '',
  ].filter(Boolean).join(' · ')

  return (
    <div className={`card card-box status-${statusClass}`} title={tip}>
      {fullKey && !editing && (
        <button
          className="box-edit"
          onClick={() => setEditing(true)}
          title="重命名"
        >
          ✎
        </button>
      )}
      <div className="box-top">
        <span className={`status-dot ${statusClass}`} />
        {editing && fullKey ? (
          <input
            className="box-name-input"
            defaultValue={label || provider.name}
            autoFocus
            placeholder={provider.name}
            onBlur={(e) => {
              void onLabelChange(fullKey, e.target.value)
              setEditing(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                void onLabelChange(fullKey, e.currentTarget.value)
                setEditing(false)
              } else if (e.key === 'Escape') {
                setEditing(false)
              }
            }}
          />
        ) : (
          <span className="box-name">{label || provider.name}</span>
        )}
      </div>
      {keyMask && <div className="box-key">{keyMask}</div>}
      <div className="box-meta">
        <span className={`box-latency ${latencyClass(s?.latency)}`}>
          {formatLatency(s?.latency ?? null)}
        </span>
        {bal.broke ? (
          <span className="box-balance box-broke" title={bal.tip || undefined}>
            没钱
          </span>
        ) : bal.text ? (
          <span
            className={`box-balance${bal.shared ? ' box-shared' : ''}`}
            title={bal.tip || undefined}
          >
            {bal.text}
          </span>
        ) : s && provider.id === 'mimo' && (s.status === 'online' || s.status === 'error') ? (
          <button
            className="btn-mini"
            onClick={handleMimoConnect}
            disabled={connecting}
            title="登录小米控制台以获取配额"
          >
            {connecting ? '等待登录…' : '连接控制台'}
          </button>
        ) : s && (s.status === 'online' || s.status === 'error') ? (
          <span className="box-balance box-noapi">无余额接口</span>
        ) : !monitoring && keyIndex >= 0 ? (
          <button className="btn-mini" onClick={() => onCheckNow(provider.id, keyIndex)}>检测</button>
        ) : null}
      </div>
    </div>
  )
}

/**
 * Field-level compare. `prev.status === next.status` never held because the
 * monitor builds a fresh status object on every transition — every card
 * re-rendered on every push. Only compare what the box actually paints.
 */
function statusShallowEqual(
  a: ProviderStatus | null | undefined,
  b: ProviderStatus | null | undefined
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.status === b.status &&
    a.latency === b.latency &&
    a.keyMask === b.keyMask &&
    a.errorCode === b.errorCode &&
    a.authStatus === b.authStatus &&
    a.lastChecked === b.lastChecked &&
    (a.balanceInfo?.available ?? null) === (b.balanceInfo?.available ?? null) &&
    (a.balanceInfo?.accountScope ?? false) === (b.balanceInfo?.accountScope ?? false)
  )
}

export default memo(ProviderCard, (prev, next) => {
  return (
    prev.monitoring === next.monitoring &&
    prev.provider === next.provider &&
    prev.keyMask === next.keyMask &&
    prev.fullKey === next.fullKey &&
    prev.label === next.label &&
    prev.keyIndex === next.keyIndex &&
    statusShallowEqual(prev.status, next.status)
  )
})
