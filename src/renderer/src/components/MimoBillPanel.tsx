import { useEffect, useState } from 'react'
import type { MimoBillSummary } from '../preload'

const formatTokens = (n: number): string => {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 万`
  return String(Math.round(n))
}

const formatCost = (n: number): string => (Number.isFinite(n) ? n.toFixed(2) : '0.00')

/**
 * 小米 MiMo 历史账单（从控制台导入）。
 *
 * 余额/用量接口只给累计值，接入本应用之前的历史这边拿不到，所以单独走控制台的
 * 「消费账单」接口（带签名）按账期逐月拉，落到本地账本里，重复导入不会翻倍。
 */
export function MimoBillPanel(): JSX.Element | null {
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  const [summary, setSummary] = useState<MimoBillSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    window.electronAPI
      .getKeys()
      .then((keys) => {
        if (!alive) return
        setHasKey((keys?.mimo ?? []).length > 0)
      })
      .catch(() => alive && setHasKey(false))
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (hasKey !== true) return
    void refresh()
    // 只按「是否有 mimo 密钥」触发一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasKey])

  async function refresh(): Promise<void> {
    setLoading(true)
    try {
      const data = await window.electronAPI.mimoGetBills()
      setSummary(data)
    } catch (err) {
      setError((err as Error)?.message ?? String(err))
    } finally {
      setLoading(false)
    }
  }

  async function importBills(): Promise<void> {
    setImporting(true)
    setMessage('')
    setError('')
    try {
      const data = await window.electronAPI.mimoImportBills(18)
      setSummary(data)
      if (data.ok) {
        setMessage(`已导入 ${data.fetched ?? 0} 条明细，账本共 ${data.rows} 条`)
      } else if (data.needLogin) {
        setMessage('')
        setError(data.error ?? '小米控制台登录已过期，请点卡片上的「连接控制台」重新登录一次')
      } else {
        setError(data.error ?? '导入失败')
      }
    } catch (err) {
      setError((err as Error)?.message ?? String(err))
    } finally {
      setImporting(false)
    }
  }

  if (hasKey !== true) return null

  const days = [...(summary?.days ?? [])].slice(-30).reverse()
  const models = summary?.models ?? []

  return (
    <section className="settings-section">
      <h2 className="settings-section-title">小米 MiMo 历史账单（从控制台导入）</h2>
      <div className="settings-card report-card">
        <div className="bailian-head">
          <div className="bailian-head-line">
            {summary && summary.rows > 0 ? (
              <span className="bailian-state ok">
                已导入 {summary.rows} 条明细 · {summary.first} ~ {summary.last}
              </span>
            ) : (
              <span className="bailian-state muted">还没导入过历史账单</span>
            )}
            {loading && <span className="bailian-state muted">读取中…</span>}
          </div>
          <div className="report-actions">
            <button className="btn btn-secondary" onClick={() => void refresh()} disabled={loading || importing}>
              刷新
            </button>
            <button className="btn btn-start" onClick={() => void importBills()} disabled={importing}>
              {importing ? '正在从控制台拉取…' : '导入最近 18 个月'}
            </button>
          </div>
        </div>
        {message && <p className="bailian-message">{message}</p>}
        {error && <p className="bailian-message err">{error}</p>}

        {summary && summary.rows > 0 && (
          <>
            <div className="report-stats">
              <div className="report-stat">
                <div className="report-stat-label">明细条数</div>
                <div className="report-stat-value">{summary.rows}</div>
                <div className="report-stat-hint">按天 × 模型 × 密钥</div>
              </div>
              <div className="report-stat">
                <div className="report-stat-label">覆盖天数</div>
                <div className="report-stat-value">{summary.days.length}</div>
                <div className="report-stat-hint">{summary.first} ~ {summary.last}</div>
              </div>
              <div className="report-stat">
                <div className="report-stat-label">累计花费</div>
                <div className="report-stat-value">{formatCost(summary.totalCost)}</div>
                <div className="report-stat-hint">CNY（控制台口径）</div>
              </div>
              <div className="report-stat">
                <div className="report-stat-label">累计 Token</div>
                <div className="report-stat-value">{formatTokens(summary.totalToken)}</div>
                <div className="report-stat-hint">{summary.requests.toLocaleString('zh-CN')} 次请求</div>
              </div>
            </div>

            <div className="mimo-bill-groups">
              <div className="mimo-bill-group">
                <h3 className="mimo-bill-title">按模型</h3>
                <table className="report-table">
                  <thead>
                    <tr>
                      <th>模型</th>
                      <th className="report-num">花费</th>
                      <th className="report-num">Token</th>
                    </tr>
                  </thead>
                  <tbody>
                    {models.map((row) => (
                      <tr key={row.model}>
                        <td>
                          <code className="bailian-model">{row.model}</code>
                        </td>
                        <td className="report-num">{formatCost(row.cost)}</td>
                        <td className="report-num">{formatTokens(row.token)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mimo-bill-group">
                <h3 className="mimo-bill-title">按天（最近 30 天）</h3>
                <table className="report-table">
                  <thead>
                    <tr>
                      <th>日期</th>
                      <th className="report-num">花费</th>
                      <th className="report-num">Token</th>
                      <th className="report-num">请求</th>
                    </tr>
                  </thead>
                  <tbody>
                    {days.map((row) => (
                      <tr key={row.date}>
                        <td>{row.date}</td>
                        <td className="report-num">{formatCost(row.cost)}</td>
                        <td className="report-num">{formatTokens(row.token)}</td>
                        <td className="report-num">{row.requests.toLocaleString('zh-CN')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {summary && summary.rows === 0 && (
          <div className="report-empty">
            点「导入最近 18 个月」会把控制台里能查到的历史账单拉下来（需要先在小卡片上点一次「连接控制台」）。
          </div>
        )}

        <p className="report-note">
          余额和用量接口只有累计值，接入本应用之前的历史只能从控制台「消费账单」里取。导入后只存在本地，重复导入自动去重。
        </p>
      </div>
    </section>
  )
}
