import { memo } from 'react'
import type { Provider, ProviderStatus } from '../preload'

interface Props {
  provider: Provider
  status: ProviderStatus | null
  onCheckNow: (id: string) => void
  monitoring: boolean
}

function formatLatency(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function latencyClass(ms: number | null): string {
  if (ms === null) return ''
  if (ms < 500) return 'good'
  if (ms < 2000) return 'warn'
  return 'bad'
}

function formatBalance(info: ProviderStatus['balanceInfo']): string {
  if (!info) return '—'
  if (info.available != null) {
    return `${Number(info.available).toFixed(2)} ${info.currency}`
  }
  return '查询中...'
}

function formatTime(ts: number | null): string {
  if (ts === null) return '未检测'
  const d = new Date(ts)
  return d.toLocaleTimeString('zh-CN', { hour12: false })
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

function ProviderCard({ provider, status, onCheckNow, monitoring }: Props) {
  const s = status
  const statusClass = s?.status ?? 'idle'

  return (
    <div className={`card status-${statusClass}`}>
      <div className="card-header">
        <div className="card-title">
          <span className="card-name">{provider.name}</span>
          <span className="card-company">{provider.company} · {provider.protocol}</span>
        </div>
        <div className="status-indicator" title={statusLabel(s?.status ?? null)}>
          <span className={`status-dot ${statusClass}`} />
        </div>
      </div>

      <div className="card-metrics">
        <div className="metric metric-primary">
          <span className="metric-label">延迟</span>
          <span className={`metric-value metric-latency ${latencyClass(s?.latency)}`}>
            {formatLatency(s?.latency ?? null)}
          </span>
        </div>
        <div className="metric">
          <span className="metric-label">状态</span>
          <span className={`metric-value metric-status ${statusClass}`}>{statusLabel(s?.status ?? null)}</span>
        </div>
        <div className="metric">
          <span className="metric-label">余额</span>
          <span className="metric-value metric-balance">{formatBalance(s?.balanceInfo)}</span>
        </div>
        <div className="metric">
          <span className="metric-label">认证</span>
          <span className={`metric-value ${s?.authStatus === 'valid' ? 'good' : s?.authStatus === 'invalid' ? 'bad' : ''}`}>
            {s?.authStatus === 'valid' ? '✓ 有效' : s?.authStatus === 'invalid' ? '✗ 无效' : '—'}
          </span>
        </div>
      </div>

      {s?.errorCode && <div className="card-error">{s.errorCode}</div>}

      <div className="card-footer">
        <span className="card-time">{formatTime(s?.lastChecked ?? null)}</span>
        {!monitoring && (
          <button className="btn-mini" onClick={() => onCheckNow(provider.id)}>检测</button>
        )}
      </div>
    </div>
  )
}

export default memo(ProviderCard, (prev, next) => {
  return (
    prev.monitoring === next.monitoring &&
    prev.provider === next.provider &&
    prev.status === next.status
  )
})