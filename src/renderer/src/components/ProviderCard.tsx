import { memo, useEffect, useState } from 'react'
import type { Provider, ProviderStatus } from '../preload'
import AgentExportModal from './AgentExportModal'
import { useBailianQuota } from '../bailianQuota'

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

/** Token 数量简写：1234567 → 「123 万」。 */
function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(2)} 亿`
  if (value >= 10_000) return `${(value / 10_000).toFixed(value >= 1_000_000 ? 0 : 1)} 万`
  return value.toLocaleString('zh-CN')
}

function latencyClass(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return ''
  if (ms < 500) return 'good'
  if (ms < 2000) return 'warn'
  return 'bad'
}

/** 中位数：单个 1~2s 的采样可能是上游抖动，取中位才代表「通常多快」。 */
function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** 限流退避的恢复时刻 → “15:03”（倒计时会随推送跳动，显示绝对时间更稳）。 */
function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  })
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

/** Mini sparkline of recent latencies — stretched viewBox, non-scaling stroke. */
function Sparkline({ data, cls }: { data: number[]; cls: string }) {
  const w = 60
  const h = 16
  const max = Math.max(...data, 1)
  const pts = data
    .map((v, i) => {
      const x = (i / Math.max(data.length - 1, 1)) * w
      const y = h - 1.5 - (v / max) * (h - 3)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg className={`spark spark-${cls || 'good'}`} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <polyline points={pts} />
    </svg>
  )
}

/**
 * 阿里云百炼的免费额度是「账号级、按模型发放」的，跟这一把 key 的余额无关，所以
 * 只在卡片左下角挂一个汇总徽标（还剩几个模型有额度），明细放在账单页。
 */
function BailianFreeBadge() {
  const { data } = useBailianQuota()
  const summary = data?.summary
  if (!data?.ok || !summary || summary.withQuota <= 0) return null
  const top = data.rows
    .filter((row) => row.isValid)
    .sort((a, b) => b.remaining - a.remaining)
    .slice(0, 5)
  const title = [
    `百炼免费额度：${summary.withQuota} 个模型还有额度（共 ${summary.total} 个）`,
    ...top.map((row) => `${row.model}：${formatTokens(row.remaining)}`),
    '明细见「账单」页',
  ].join('\n')
  return (
    <span className="box-balance box-free" title={title}>
      免费 {summary.withQuota} 个
    </span>
  )
}

/**
 * Small box card — one per API key. Name + key mask + status dot on top,
 * latency + balance below. Detail lives in the hover tooltip.
 */
function ProviderCard({ provider, keyMask, fullKey, label, keyIndex, status, onCheckNow, onLabelChange, monitoring }: Props) {
  const s = status
  const statusClass = s?.status ?? 'idle'
  const bal = formatBalance(s?.balanceInfo)
  // 有的厂商（Moonshot、小米 MiMo）余额耗尽时回的是 429，而小米的余额还得登录控制台
  // 才查得到 —— 没连控制台时卡片拿不到数字，只在 errorCode 上留下「余额不足」。这种
  // 已知没钱的 key 也算 broke：直接显示「没钱」，别再催用户去连控制台登录。
  const broke = bal.broke || s?.errorCode === '余额不足，无法调用'
  const hist = s?.latencyHistory ?? []
  const throttledUntil = s?.throttledUntil ?? 0
  // 欠费优先于限流：有的厂商（Moonshot）把「余额不足」也回成 429，卡片只该显示「没钱」。
  const throttled = throttledUntil > Date.now() && !broke
  const [editing, setEditing] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [copied, setCopied] = useState(false)
  // 登录提示不要用 window.alert：它是同步阻塞的，会把整个渲染进程（包括所有卡片的
  // 状态刷新）卡在弹窗上，直到用户点确定。改成卡片内的短暂提示。
  const [notice, setNotice] = useState('')
  const [, forceTick] = useState(0)

  // 限流徽标是按「当前时间」算出来的，但冷却期内主进程不再推状态，倒计时到点后卡片
  // 不会自己重画，徽标就会一直挂着那个已经过去的时刻。到点主动重渲染一次把它摘掉。
  useEffect(() => {
    if (throttledUntil <= Date.now()) return
    const timer = setTimeout(
      () => forceTick((n) => n + 1),
      Math.min(throttledUntil - Date.now() + 200, 16 * 60 * 1000)
    )
    return () => clearTimeout(timer)
  }, [throttledUntil])

  const handleCopyKey = async () => {
    if (!fullKey) return
    try {
      await window.electronAPI.copyText(fullKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard denied */
    }
  }

  const handleMimoConnect = async () => {
    if (!fullKey) return
    setConnecting(true)
    try {
      // 传这把密钥的尾 6 位：控制台按「小米账号」登录，一个小米账号一条会话，
      // 想连 7001 的账号就点 7001 的按钮，不会被自动登回 7002 的账号。
      const res = await window.electronAPI.mimoConnect(fullKey.slice(-6))
      if (res?.ok && res.keyFound === false) {
        setNotice(
          `刚登录的小米账号（${res.accountId ?? '未知'}）名下没有…${fullKey.slice(-6)} 这把密钥，登错账号了：再点一次「连接控制台」登录它所属的账号`
        )
        setTimeout(() => setNotice(''), 12_000)
      }
    } finally {
      setConnecting(false)
    }
  }
  const tip = [
    statusLabel(s?.status ?? null),
    throttled ? `限流退避至 ${formatClock(throttledUntil)}` : '',
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
        <span className={`status-dot ${statusClass}${throttled ? ' throttled' : ''}`} />
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
      {keyMask && (
        <div className="box-key-row">
          <div className="box-key">{keyMask}</div>
          {fullKey && (
            <div className="box-actions">
              <button
                className="box-action"
                onClick={() => void handleCopyKey()}
                title="复制完整密钥"
              >
                {copied ? '✓' : '⧉'}
              </button>
              <button
                className="box-action"
                onClick={() => setShowExport(true)}
                title="导出到 Agent"
              >
                ⇪
              </button>
            </div>
          )}
        </div>
      )}
      {hist.length >= 2 && (
        <div
          className="box-spark"
          title={`最近 ${hist.length} 次延迟：${formatLatency(Math.min(...hist))} ~ ${formatLatency(Math.max(...hist))}`}
        >
          <Sparkline data={hist} cls={latencyClass(s?.latency ?? null)} />
        </div>
      )}
      <div className="box-meta">
        <span className="box-left">
          <span
            className={`box-latency ${latencyClass(s?.latency)}`}
            title={
              s?.latency == null
                ? '首字延迟（TTFT）：从发出请求到收到第一个 token 的时间'
                : `首字延迟（TTFT）：从发出请求到收到第一个 token 的时间${hist.length >= 2 ? `；最近 ${hist.length} 次中位 ${formatLatency(median(hist))}` : ''}`
            }
          >
            {formatLatency(s?.latency ?? null)}
          </span>
          {throttled && (
            <span
              className="box-balance box-throttle"
              title={`被厂商限流（429），将于 ${new Date(throttledUntil).toLocaleTimeString('zh-CN', { hour12: false })} 自动重试`}
            >
              限流 {formatClock(throttledUntil)}
            </span>
          )}
          {notice && (
            <span className="box-balance box-throttle" title={notice}>
              登错账号？
            </span>
          )}
          {provider.id === 'qwen' && <BailianFreeBadge />}
        </span>
        {broke ? (
          <span
            className="box-balance box-broke"
            title={bal.tip || '这个账号已经没有额度了，不用再连控制台'}
          >
            没钱
          </span>
        ) : bal.text ? (
          <span
            className={`box-balance${bal.shared ? ' box-shared' : ''}`}
            title={bal.tip || undefined}
          >
            {bal.text}
          </span>
        ) : s && provider.id === 'mimo' ? (
          // 小米的余额属于控制台账号，而不是 sk- 密钥：这把 key 还没连过它所属的
          // 账号（拿不到余额）时才给登录入口。连上之后显示的是「它自己账号」的钱包。
          <button
            className="btn-mini"
            onClick={handleMimoConnect}
            disabled={connecting}
            title="登录这把密钥所属的小米账号（每个账号单独登录，余额互不串号）"
          >
            {connecting ? '等待登录…' : '连接控制台'}
          </button>
        ) : s && provider.id !== 'mimo' && (s.status === 'online' || s.status === 'error') ? (
          <span className="box-balance box-noapi">无余额接口</span>
        ) : !monitoring && keyIndex >= 0 ? (
          <button className="btn-mini" onClick={() => onCheckNow(provider.id, keyIndex)}>检测</button>
        ) : null}
      </div>

      {showExport && fullKey && (
        <AgentExportModal
          provider={provider}
          apiKey={fullKey}
          label={label || provider.name}
          onClose={() => setShowExport(false)}
        />
      )}
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
    // 限流退避窗口变了就要重画徽标/圆点，否则会一直显示旧的恢复时刻
    (a.throttledUntil ?? 0) === (b.throttledUntil ?? 0) &&
    (a.latencyHistory?.join(',') ?? '') === (b.latencyHistory?.join(',') ?? '') &&
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
