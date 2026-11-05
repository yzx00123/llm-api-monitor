import { useMemo } from 'react'
import type { Provider, ProviderStatus } from '../preload'
import ProviderCard from './ProviderCard'

interface Props {
  providers: Provider[]
  statuses: Record<string, ProviderStatus>
  onCheckNow: (id: string) => void
  monitoring: boolean
}

const GROUP_LABELS: Record<string, string> = {
  international: '国际厂商',
  china: '国内厂商',
  aggregator: '聚合平台',
}

export default function Dashboard({ providers, statuses, onCheckNow, monitoring }: Props) {
  const grouped = useMemo(() => {
    const groups: Record<string, Provider[]> = {
      international: [],
      china: [],
      aggregator: [],
    }
    for (const p of providers) {
      if (groups[p.category]) groups[p.category].push(p)
    }
    return groups
  }, [providers])

  if (providers.length === 0) {
    return <div className="dashboard-empty"><h2>加载中...</h2></div>
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
              {list.map((p) => (
                <ProviderCard
                  key={p.id}
                  provider={p}
                  status={statuses[p.id] ?? null}
                  onCheckNow={onCheckNow}
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