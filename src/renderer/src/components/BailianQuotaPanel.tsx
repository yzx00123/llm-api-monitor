import { useEffect, useState } from 'react'
import { refreshBailianQuota, useBailianQuota } from '../bailianQuota'
import type { FreeQuotaRow } from '../preload'

/**
 * 账单页里的「阿里云百炼免费额度」区块。
 *
 * 百炼的免费额度按模型发放（每个模型 100 万 Token、90 天有效），官方只在控制台
 * 里展示，没有对外的查询接口。所以这里的数据来自「登录百炼控制台」之后的内部
 * 接口，未登录时给一个登录入口，而不是假装没有这个功能。
 */

const MODEL_TYPE_LABELS: Record<FreeQuotaRow['modelType'], string> = {
  Text: '大语言模型',
  Vision: '视觉模型',
  Multimodal: '多模态模型',
  Audio: '语音模型',
  Embedding: '向量模型',
}

function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(2)} 亿`
  if (value >= 10_000) return `${(value / 10_000).toFixed(value >= 1_000_000 ? 0 : 1)} 万`
  return value.toLocaleString('zh-CN')
}

function formatExpire(expireAt?: number): string {
  if (!expireAt) return '每月重置'
  const date = new Date(expireAt)
  const days = Math.ceil((expireAt - Date.now()) / 86_400_000)
  const day = `${date.getMonth() + 1}/${date.getDate()}`
  if (days <= 0) return `${day} 已过期`
  if (days <= 30) return `${day}（剩 ${days} 天）`
  return day
}

function remainPercent(row: FreeQuotaRow): number {
  if (typeof row.remainPercentage === 'number') return Math.max(0, Math.min(100, row.remainPercentage))
  if (row.total > 0) return Math.max(0, Math.min(100, (row.remaining / row.total) * 100))
  return 0
}

function toneClass(row: FreeQuotaRow): string {
  if (!row.isValid) return 'bailian-tier exhausted'
  const percent = remainPercent(row)
  if (percent <= 20) return 'bailian-tier bad'
  if (percent <= 50) return 'bailian-tier warn'
  return 'bailian-tier good'
}

export function BailianQuotaPanel(): JSX.Element | null {
  const { data, loading, error, refresh } = useBailianQuota()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  // 没导入百炼密钥的人不显示这一块 —— 免费额度是给「有百炼 key」的人看的，
  // 对其它用户就是一段噪音。每次进账单页重新判断一次（新导入 key 后立刻出现）。
  const [hasKey, setHasKey] = useState<boolean | null>(null)

  useEffect(() => {
    let alive = true
    void window.electronAPI
      .getKeys()
      .then((keys) => {
        if (alive) setHasKey((keys?.qwen ?? []).length > 0)
      })
      .catch(() => {
        if (alive) setHasKey(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const login = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await window.electronAPI.bailianLogin()
      if (result.ok) {
        await refreshBailianQuota(true)
        setMessage('已登录百炼控制台，免费额度已更新')
      } else {
        setMessage(result.error ?? '登录没有完成')
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const logout = async () => {
    setBusy(true)
    try {
      await window.electronAPI.bailianLogout()
      await refreshBailianQuota(true)
      setMessage('已退出百炼控制台登录')
    } finally {
      setBusy(false)
    }
  }

  const rows = data?.rows ?? []
  const summary = data?.summary
  const loggedIn = data?.loggedIn === true
  // 用尽/过期的模型也列出来（排到最后），否则用户以为「这个模型没有免费额度」，
  // 实际是已经花完了 —— 免费额度按模型发放，逐个看才分得清。
  const sortedRows = [...rows].sort((a, b) => {
    if (a.isValid !== b.isValid) return a.isValid ? -1 : 1
    return remainPercent(b) - remainPercent(a)
  })

  if (hasKey !== true) return null

  return (
    <>
      <h2 className="settings-section-title">阿里云百炼免费额度（按模型）</h2>
      <div className="settings-card report-card">
        <div className="bailian-head">
          <div className="bailian-head-line">
            {loggedIn ? (
              <span className="bailian-state ok">
                已登录百炼控制台
                {data?.fetchedAt ? ` · ${new Date(data.fetchedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : ''}
              </span>
            ) : (
              <span className="bailian-state muted">未登录 —— 免费额度只能在控制台里查</span>
            )}
            {loading && <span className="bailian-state muted">读取中…</span>}
          </div>
          <div className="report-actions">
            <button className="btn btn-secondary" onClick={() => void refresh()} disabled={loading || busy}>
              刷新
            </button>
            {loggedIn ? (
              <button className="btn btn-secondary" onClick={() => void logout()} disabled={busy}>
                退出登录
              </button>
            ) : (
              <button className="btn btn-start" onClick={() => void login()} disabled={busy}>
                {busy ? '等待登录…' : '登录百炼控制台'}
              </button>
            )}
          </div>
        </div>

        {message && <p className="bailian-message">{message}</p>}
        {!message && error && <p className="bailian-message err">{error}</p>}

        {summary && loggedIn && (
          <div className="report-stats">
            <div className="report-stat">
              <div className="report-stat-label">有额度模型</div>
              <div className="report-stat-value">
                {summary.withQuota}
                <span className="bailian-unit"> / {summary.total}</span>
              </div>
              <div className="report-stat-hint">剩下的可能用尽或未开通</div>
            </div>
            <div className="report-stat">
              <div className="report-stat-label">使用率 &gt;50%</div>
              <div className="report-stat-value">{summary.over50}</div>
              <div className="report-stat-hint">剩余 20%~50%</div>
            </div>
            <div className="report-stat">
              <div className="report-stat-label">使用率 &gt;80%</div>
              <div className="report-stat-value">{summary.over80}</div>
              <div className="report-stat-hint">剩余不足 20%，快用完了</div>
            </div>
            <div className="report-stat">
              <div className="report-stat-label">剩余 Token 合计</div>
              <div className="report-stat-value">{formatTokens(summary.remainingTokens)}</div>
              <div className="report-stat-hint">共发放 {formatTokens(summary.totalTokens)}</div>
            </div>
          </div>
        )}

        {loggedIn && rows.length > 0 && (
          <table className="report-table bailian-table">
            <thead>
              <tr>
                <th>模型</th>
                <th>类型</th>
                <th className="report-num">剩余额度</th>
                <th>余量</th>
                <th>到期</th>
                <th>用完即停</th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row) => {
                const percent = remainPercent(row)
                return (
                  <tr key={`${row.modelType}-${row.model}`}>
                    <td>
                      <code className="bailian-model">{row.model}</code>
                    </td>
                    <td className="bailian-type">{MODEL_TYPE_LABELS[row.modelType]}</td>
                    <td className="report-num">
                      {formatTokens(row.remaining)}
                      <span className="bailian-total"> / {formatTokens(row.total)}</span>
                    </td>
                    <td>
                      <span className={toneClass(row)} title={row.isValid ? undefined : '额度已用尽或已过期'}>
                        <span className="bailian-bar">
                          <span className="bailian-bar-fill" style={{ width: `${percent}%` }} />
                        </span>
                        <span className="bailian-percent">{percent.toFixed(0)}%</span>
                      </span>
                    </td>
                    <td>{formatExpire(row.expireAt)}</td>
                    <td>{row.isValid ? (row.stopOnExhaust ? '已开启' : '未开启') : '已用尽'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}

        {loggedIn && rows.length === 0 && (
          <div className="report-empty">这个账号没有可用的免费额度（可能都用完了，或者没开通百炼）。</div>
        )}

        <p className="report-note">
          免费额度按<b>模型</b>独立发放（通常每个模型 100 万 Token、90 天内有效，仅华北2·北京地域），
          官方没有查询接口，所以这里靠「登录百炼控制台」读取，登录状态保存在本机。数据不会上传到任何地方；
          想断开时点「退出登录」清掉 cookie 即可。
        </p>
      </div>
    </>
  )
}
