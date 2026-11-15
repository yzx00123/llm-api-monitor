import { useMemo } from 'react'
import type { Provider, ProviderStatus } from '../preload'
import ProviderCard from './ProviderCard'

interface Props {
  providers: Provider[]
  /** providerId -> key list; dashboard expands one box per key. */
  keys: Record<string, string[]>
  /** full key -> custom display name */
  labels: Record<string, string>
  statuses: Record<string, ProviderStatus>
  onCheckNow: (id: string, keyIndex: number) => void
  onLabelChange: (key: string, label: string) => Promise<void>
  monitoring: boolean
}

const GROUP_LABELS: Record<string, string> = {
  international: '国际厂商',
  china: '国内厂商',
  aggregator: '聚合平台',
  custom: '自定义',
}

function maskKey(key: string): string {
  if (key.length <= 12) return key
  return `${key.slice(0, 6)}••••${key.slice(-4)}`
}

/** One box per (provider, key) pair — providers with 2 keys get 2 boxes.
 *  Providers without keys are skipped: the dashboard only shows what is actually in use. */
function buildUnits(providers: Provider[], keys: Record<string, string[]>, labels: Record<string, string>) {
  const groups: Record<string, Array<{ provider: Provider; keyIndex: number; keyMask: string; fullKey: string; label: string; statusKey: string }>> = {
    international: [],
    china: [],
    aggregator: [],
    custom: [],
  }
  for (const p of providers) {
    if (!groups[p.category]) continue
    const ks = keys[p.id] ?? []
    // Skip unused providers — no placeholder cards for empty vendors.
    if (ks.length === 0) continue
    ks.forEach((k, i) => {
      groups[p.category].push({
        provider: p,
        keyIndex: i,
        keyMask: maskKey(k),
        fullKey: k,
        label: labels[k] ?? '',
        statusKey: `${p.id}#${i}`,
      })
    })
  }
  return groups
}

export default function Dashboard({ providers, keys, labels, statuses, onCheckNow, onLabelChange, monitoring }: Props) {
  const grouped = useMemo(() => buildUnits(providers, keys, labels), [providers, keys, labels])

  const total = Object.values(grouped).reduce((s, l) => s + l.length, 0)
  if (total === 0) {
    return (
      <div className="dashboard-empty">
        <h2>暂无已导入的 API 密钥</h2>
        <p>去「密钥管理」导入密钥后，这里只显示正在使用的厂商</p>
      </div>
    )
  }

  return (
    <div>
      {Object.entries(grouped).map(([category, list]) => {
        if (list.length === 0) return null
        return (
          <div key={category} className="category-group">
            <div className="category-label">
              {GROUP_LABELS[category] ?? category}
              <span className="category-count">{list.length}</span>
            </div>
            <div className="grid">
              {list.map((u) => (
                <ProviderCard
                  key={u.statusKey}
                  provider={u.provider}
                  keyMask={u.keyMask}
                  fullKey={u.fullKey}
                  label={u.label}
                  keyIndex={u.keyIndex}
                  status={statuses[u.statusKey] ?? null}
                  onCheckNow={onCheckNow}
                  onLabelChange={onLabelChange}
                  monitoring={monitoring}
                />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
