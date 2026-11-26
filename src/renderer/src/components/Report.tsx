import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DailyReport,
  ReportDay,
  ReportProviderAmount,
  TokenReport,
  UsageReport
} from '../preload'
import { BailianQuotaPanel } from './BailianQuotaPanel'
import { MimoBillPanel } from './MimoBillPanel'

interface ReportProps {
  onBack: () => void
}

type ChartMode = 'line' | 'bar' | 'treemap'

const RANGES = [
  { days: 7, label: '近 7 天' },
  { days: 30, label: '近 30 天' },
  { days: 90, label: '近 90 天' }
]

const CHART_MODES: { id: ChartMode; label: string }[] = [
  { id: 'line', label: '折线图' },
  { id: 'bar', label: '柱状图' },
  { id: 'treemap', label: '树状图' }
]

const PALETTE = ['#10a37f', '#4f7cff', '#f59e0b', '#e0533d', '#8b5cf6', '#0ea5e9', '#14b8a6', '#ec4899']

function currencyUnit(currency: string): string {
  if (currency === 'CNY') return '元'
  if (currency === 'USD') return '美元'
  return currency
}

function money(v: number, currency: string): string {
  return `${v.toFixed(2)} ${currencyUnit(currency)}`
}

function shortDate(date: string): string {
  return date.slice(5)
}

function niceCeil(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1
  const mag = Math.pow(10, Math.floor(Math.log10(v)))
  const n = v / mag
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10
  return step * mag
}

function tickText(v: number): string {
  if (v === 0) return '0'
  if (v >= 100) return v.toFixed(0)
  if (v >= 10) return v.toFixed(0)
  if (v >= 1) return v.toFixed(1)
  return v.toFixed(2)
}

const CHART_W = 760
const CHART_H = 220
const PAD = { top: 18, right: 18, bottom: 30, left: 54 }

function axisLabels(count: number): number[] {
  if (count <= 1) return [0]
  const step = Math.max(1, Math.ceil(count / 7))
  const out: number[] = []
  for (let i = 0; i < count; i += step) out.push(i)
  if (out[out.length - 1] !== count - 1) out.push(count - 1)
  return out
}

function LineChart({ days, currency }: { days: ReportDay[]; currency: string }) {
  const plotW = CHART_W - PAD.left - PAD.right
  const plotH = CHART_H - PAD.top - PAD.bottom
  const max = niceCeil(Math.max(...days.map((d) => d.total), 0))
  const x = (i: number) => PAD.left + (i / Math.max(1, days.length - 1)) * plotW
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH
  const pts = days.map((d, i) => `${x(i).toFixed(1)},${y(d.total).toFixed(1)}`)
  const baseY = PAD.top + plotH
  const area = `M${x(0).toFixed(1)},${baseY.toFixed(1)} L${pts.join(' L')} L${x(days.length - 1).toFixed(1)},${baseY.toFixed(1)} Z`
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max)

  return (
    <svg className="report-chart" viewBox={`0 0 ${CHART_W} ${CHART_H}`} role="img" aria-label="每日消费折线图">
      <defs>
        <linearGradient id="reportLineFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--green)" stopOpacity="0.3" />
          <stop offset="100%" stopColor="var(--green)" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={PAD.left} y1={y(t)} x2={CHART_W - PAD.right} y2={y(t)} className="report-grid" />
          <text x={PAD.left - 10} y={y(t) + 4} className="report-axis-text" textAnchor="end">
            {tickText(t)}
          </text>
        </g>
      ))}
      <path d={area} fill="url(#reportLineFill)" />
      <polyline points={pts.join(' ')} className="report-line" />
      {days.map((d, i) =>
        d.total > 0 ? (
          <circle key={d.date} cx={x(i)} cy={y(d.total)} r={3} className="report-dot">
            <title>{`${d.date}：${money(d.total, currency)}`}</title>
          </circle>
        ) : null
      )}
      {axisLabels(days.length).map((i) => (
        <text key={`x${i}`} x={x(i)} y={CHART_H - 9} className="report-axis-text" textAnchor="middle">
          {shortDate(days[i].date)}
        </text>
      ))}
    </svg>
  )
}

function BarChart({ days, currency }: { days: ReportDay[]; currency: string }) {
  const plotW = CHART_W - PAD.left - PAD.right
  const plotH = CHART_H - PAD.top - PAD.bottom
  const max = niceCeil(Math.max(...days.map((d) => d.total), 0))
  const slot = plotW / Math.max(1, days.length)
  const barW = Math.max(2, Math.min(28, slot * 0.62))
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH
  const baseY = PAD.top + plotH
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max)

  return (
    <svg className="report-chart" viewBox={`0 0 ${CHART_W} ${CHART_H}`} role="img" aria-label="每日消费柱状图">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={PAD.left} y1={y(t)} x2={CHART_W - PAD.right} y2={y(t)} className="report-grid" />
          <text x={PAD.left - 10} y={y(t) + 4} className="report-axis-text" textAnchor="end">
            {tickText(t)}
          </text>
        </g>
      ))}
      {days.map((d, i) => {
        const cx = PAD.left + slot * (i + 0.5)
        const top = y(d.total)
        const h = Math.max(0, baseY - top)
        return (
          <rect
            key={d.date}
            x={cx - barW / 2}
            y={top}
            width={barW}
            height={h}
            rx={Math.min(3, barW / 2)}
            className={d.total > 0 ? 'report-bar' : 'report-bar muted'}
          >
            <title>{`${d.date}：${money(d.total, currency)}`}</title>
          </rect>
        )
      })}
      {axisLabels(days.length).map((i) => (
        <text
          key={`x${i}`}
          x={PAD.left + slot * (i + 0.5)}
          y={CHART_H - 9}
          className="report-axis-text"
          textAnchor="middle"
        >
          {shortDate(days[i].date)}
        </text>
      ))}
    </svg>
  )
}

interface Block {
  key: string
  name: string
  amount: number
  x: number
  y: number
  w: number
  h: number
}

interface Tile {
  key: string
  name: string
  amount: number
  area: number
}

function squarify(items: Tile[], x0: number, y0: number, w0: number, h0: number, out: Block[]): void {
  if (items.length === 0) return
  if (items.length === 1) {
    const it = items[0]
    out.push({ key: it.key, name: it.name, amount: it.amount, x: x0, y: y0, w: w0, h: h0 })
    return
  }
  const total = items.reduce((s, i) => s + i.area, 0)
  let acc = 0
  let split = 1
  for (let i = 0; i < items.length - 1; i++) {
    acc += items[i].area
    if (acc >= total / 2) {
      split = i + 1
      break
    }
  }
  const a = items.slice(0, split)
  const b = items.slice(split)
  const aTotal = a.reduce((s, i) => s + i.area, 0)
  const frac = total > 0 ? aTotal / total : 0.5
  if (w0 >= h0) {
    const aw = w0 * frac
    squarify(a, x0, y0, aw, h0, out)
    squarify(b, x0 + aw, y0, w0 - aw, h0, out)
  } else {
    const ah = h0 * frac
    squarify(a, x0, y0, w0, ah, out)
    squarify(b, x0, y0 + ah, w0, h0 - ah, out)
  }
}

function Treemap({ items, currency }: { items: ReportProviderAmount[]; currency: string }) {
  const list = items.filter((i) => i.amount > 0)
  const blocks = useMemo(() => {
    const w = CHART_W
    const h = CHART_H
    const total = list.reduce((s, i) => s + i.amount, 0)
    const tiles: Tile[] = list.map((i) => ({
      key: i.providerId,
      name: i.name,
      amount: i.amount,
      area: total > 0 ? (i.amount / total) * w * h : 0
    }))
    const out: Block[] = []
    squarify(tiles, 0, 0, w, h, out)
    return out
  }, [list])

  if (list.length === 0) {
    return <div className="report-empty">这段时间没有消费记录，先让软件跑一段时间，有了余额变化就会自动统计。</div>
  }

  return (
    <svg className="report-chart report-treemap" viewBox={`0 0 ${CHART_W} ${CHART_H}`} role="img" aria-label="厂商消费占比">
      {blocks.map((b, i) => {
        const showText = b.w > 70 && b.h > 34
        return (
          <g key={b.key}>
            <rect x={b.x + 1} y={b.y + 1} width={Math.max(0, b.w - 2)} height={Math.max(0, b.h - 2)} rx={6} fill={PALETTE[i % PALETTE.length]} fillOpacity={0.86}>
              <title>{`${b.name}：${money(b.amount, currency)}（${((b.amount / list.reduce((s, x) => s + x.amount, 0)) * 100).toFixed(1)}%）`}</title>
            </rect>
            {showText && (
              <>
                <text x={b.x + 10} y={b.y + 22} className="report-treemap-name">
                  {b.name}
                </text>
                <text x={b.x + 10} y={b.y + 40} className="report-treemap-value">
                  {money(b.amount, currency)}
                </text>
              </>
            )}
          </g>
        )
      })}
    </svg>
  )
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="report-stat">
      <div className="report-stat-label">{label}</div>
      <div className="report-stat-value">{value}</div>
      {hint && <div className="report-stat-hint">{hint}</div>}
    </div>
  )
}

function formatTokens(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—'
  if (v >= 100000000) return `${(v / 100000000).toFixed(2)} 亿`
  if (v >= 10000) return `${(v / 10000).toFixed(1)} 万`
  return v.toLocaleString('zh-CN')
}

export default function Report({ onBack }: ReportProps): React.JSX.Element {
  const [days, setDays] = useState(30)
  const [mode, setMode] = useState<ChartMode>('line')
  const [currency, setCurrency] = useState<string | undefined>(undefined)
  const [report, setReport] = useState<DailyReport | null>(null)
  const [usage, setUsage] = useState<UsageReport | null>(null)
  const [token, setToken] = useState<TokenReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [exportMsg, setExportMsg] = useState('')

  // 请求序号：快速连点「近 7 天」→「近 30 天」时两个请求同时在飞，后发先至会让旧
  // 结果覆盖新结果（按钮高亮 30 天、图表却是 7 天的数据）。只接受最新一次的结果。
  const loadSeq = useRef(0)

  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    try {
      const [daily, usageReport, tokenReport] = await Promise.all([
        window.electronAPI.getDailyReport(days, currency),
        window.electronAPI.getUsageReport(days),
        window.electronAPI.getTokenReport(days)
      ])
      if (seq !== loadSeq.current) return
      setReport(daily)
      setUsage(usageReport)
      setToken(tokenReport)
      if (daily.currencies.length > 0 && !currency) setCurrency(daily.currencies[0])
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }, [days, currency])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const timer = window.setInterval(() => void load(), 60000)
    return () => window.clearInterval(timer)
  }, [load])

  const handleExport = async (): Promise<void> => {
    setExporting(true)
    try {
      const res = await window.electronAPI.exportReportCsv(days, currency)
      setExportMsg(res.ok ? `已导出：${res.path}` : '已取消')
    } catch (err) {
      setExportMsg(`导出失败：${String(err)}`)
    } finally {
      setExporting(false)
    }
  }

  const activeCurrency = report?.currency ?? currency ?? 'CNY'
  const chartDays = report?.days ?? []
  const totalSpend = useMemo(() => chartDays.reduce((s, d) => s + d.total, 0), [chartDays])
  const rows = useMemo(
    () => [...chartDays].reverse().filter((d) => d.total > 0),
    [chartDays]
  )
  const providerNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of report?.providerTotals ?? []) map.set(p.providerId, p.name)
    return map
  }, [report])

  const usageDays = usage?.available ? usage : null

  return (
    <div className="report-page">
      <header className="report-top">
        <div className="report-top-left">
          <button className="settings-back" onClick={onBack}>
            ← 返回
          </button>
          <div>
            <h2 className="settings-section-title report-h">消费账单</h2>
            <div className="report-sub">
              按天统计各厂商的扣费（来自余额变化），共 {report?.sampleCount ?? 0} 个余额采样
            </div>
          </div>
        </div>
        <div className="report-actions">
          {(report?.currencies.length ?? 0) > 1 && (
            <div className="set-segmented">
              {(report?.currencies ?? []).map((c) => (
                <button
                  key={c}
                  className={c === activeCurrency ? 'active' : ''}
                  onClick={() => setCurrency(c)}
                >
                  {currencyUnit(c)}
                </button>
              ))}
            </div>
          )}
          <div className="set-segmented">
            {RANGES.map((r) => (
              <button
                key={r.days}
                className={r.days === days ? 'active' : ''}
                onClick={() => setDays(r.days)}
              >
                {r.label}
              </button>
            ))}
          </div>
          <div className="set-segmented">
            {CHART_MODES.map((m) => (
              <button key={m.id} className={m.id === mode ? 'active' : ''} onClick={() => setMode(m.id)}>
                {m.label}
              </button>
            ))}
          </div>
          <button className="btn btn-start" onClick={() => void handleExport()} disabled={exporting}>
            {exporting ? '导出中…' : '导出 CSV'}
          </button>
        </div>
      </header>

      {exportMsg && <div className="report-export-msg">{exportMsg}</div>}

      <div className="report-stats">
        <StatCard label="今日消费" value={money(report?.totals.today ?? 0, activeCurrency)} />
        <StatCard label="近 7 天" value={money(report?.totals.week ?? 0, activeCurrency)} />
        <StatCard
          label="本月"
          value={money(report?.totals.month ?? 0, activeCurrency)}
          hint="按自然月统计"
        />
        <StatCard
          label="累计"
          value={money(report?.totals.all ?? 0, activeCurrency)}
          hint={report?.firstSampleAt ? `自 ${new Date(report.firstSampleAt).toLocaleDateString('zh-CN')} 起` : '还没有采样'}
        />
      </div>

      <h2 className="settings-section-title">每日消费</h2>
      <div className="settings-card report-card">
        {loading && chartDays.length === 0 ? (
          <div className="report-empty">正在读取本地账单…</div>
        ) : totalSpend <= 0 && mode !== 'treemap' ? (
          <div className="report-empty">
            这 {days} 天没有检测到消费。余额变小才会记一笔——先跑一轮检测，之后就会自动累积。
          </div>
        ) : (
          <>
            {mode === 'line' && <LineChart days={chartDays} currency={activeCurrency} />}
            {mode === 'bar' && <BarChart days={chartDays} currency={activeCurrency} />}
            {mode === 'treemap' && (
              <>
                <Treemap items={report?.providerTotals ?? []} currency={activeCurrency} />
                <div className="report-legend">
                  {(report?.providerTotals ?? []).filter((p) => p.amount > 0).map((p, i) => (
                    <span key={p.providerId} className="report-legend-item">
                      <i style={{ background: PALETTE[i % PALETTE.length] }} />
                      {p.name} {money(p.amount, activeCurrency)}
                    </span>
                  ))}
                </div>
              </>
            )}
            {mode !== 'treemap' && (
              <div className="report-legend report-legend-plain">
                {(report?.providerTotals ?? [])
                  .filter((p) => p.amount > 0)
                  .map((p) => (
                    <span key={p.providerId} className="report-legend-item">
                      {p.name} <b>{money(p.amount, activeCurrency)}</b>
                    </span>
                  ))}
              </div>
            )}
          </>
        )}
      </div>

      <h2 className="settings-section-title">消费明细</h2>
      <div className="settings-card report-card">
        {rows.length === 0 ? (
          <div className="report-empty">还没有消费记录。</div>
        ) : (
          <table className="report-table">
            <thead>
              <tr>
                <th>日期</th>
                <th className="report-num">消费</th>
                <th>厂商明细</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.date}>
                  <td className="report-date">{d.date}</td>
                  <td className="report-num">{money(d.total, activeCurrency)}</td>
                  <td>
                    <span className="report-chips">
                      {d.byProvider.map((p) => (
                        <span key={p.providerId} className="report-chip">
                          {providerNames.get(p.providerId) ?? p.name}
                          <b>{money(p.amount, activeCurrency)}</b>
                        </span>
                      ))}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2 className="settings-section-title">token 用量</h2>
      <div className="settings-card report-card">
        {token && token.sampleCount > 0 ? (
          <>
            <div className="report-stats report-stats-usage">
              <StatCard label="今日 token" value={formatTokens(token.todayToken)} />
              <StatCard label="近 7 天 token" value={formatTokens(token.weekToken)} />
              <StatCard label="本月 token" value={formatTokens(token.monthToken)} />
              <StatCard
                label="累计 token"
                value={formatTokens(token.allToken)}
                hint={token.firstDay ? `自 ${token.firstDay} 起` : undefined}
              />
            </div>

            {token.providerTotals.length > 0 && (
              <table className="report-table">
                <thead>
                  <tr>
                    <th>厂商</th>
                    <th className="report-num">输入</th>
                    <th className="report-num">输出</th>
                    <th className="report-num">合计</th>
                  </tr>
                </thead>
                <tbody>
                  {token.providerTotals.map((p) => (
                    <tr key={p.providerId}>
                      <td>{p.name}</td>
                      <td className="report-num">{formatTokens(p.prompt)}</td>
                      <td className="report-num">{formatTokens(p.completion)}</td>
                      <td className="report-num">
                        <strong>{formatTokens(p.total)}</strong>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <p className="report-note">
              这里统计的是<b>本软件自己发起的探测</b>所消耗的 token（每次检测延迟都会向厂商发一小段请求），按天 ×
              厂商累加，所有厂商通用。它不是厂商账单里的总用量 —— 你平时在别处调 API
              花的 token 不会算进来，本软件也不读任何厂商的账单接口。
            </p>
          </>
        ) : (
          <div className="report-empty">
            还没有探测记录。开始监测后，每次延迟检测都会统计消耗的 token，这里就会按厂商汇总。
          </div>
        )}
      </div>

      {usageDays && (
        <>
          <h2 className="settings-section-title">MiMo 控制台用量（账户级）</h2>
          <div className="settings-card report-card">
            <div className="report-stats report-stats-usage">
              <StatCard label="今日 token" value={formatTokens(usageDays.todayToken)} />
              <StatCard label="本月 token" value={formatTokens(usageDays.monthToken)} />
              <StatCard label="累计 token" value={formatTokens(usageDays.totalToken)} />
              <StatCard
                label="本月花费"
                value={usageDays.monthCost === null ? '—' : money(usageDays.monthCost, 'CNY')}
                hint="控制台当月统计"
              />
              <StatCard
                label="累计花费"
                value={usageDays.totalCost === null ? '—' : money(usageDays.totalCost, 'CNY')}
                hint="控制台历史总计"
              />
            </div>
            <p className="report-note">
              这一段是<b>小米 MiMo 控制台的账户级用量</b>（你在所有地方花的都算，含输入/输出/命中缓存），按天做差值；只有在「密钥管理 → 连接
              MiMo 控制台」保持登录时才会更新。其他厂商没有开放这类接口，所以只显示上面的探测用量。
            </p>
          </div>
        </>
      )}

      <MimoBillPanel />
      <BailianQuotaPanel />

      <p className="report-note">
        统计口径：① 每天的花费 = 当天首次余额 − 当天最后一次余额，只统计软件运行期间；② 软件关掉的时段产生的费用，会并到下次打开软件那一天；③
        当天充过值会抵消消费，那天可能按 0 记；④ 首日没有参照，从第二天开始才有数。
      </p>
    </div>
  )
}
