import {
  BalanceSample,
  UsageSample,
  getBalanceHistory,
  getCustomProviders,
  getProbeUsage,
  getUsageHistory,
} from './store'
import { PROVIDERS } from './providers'

/**
 * 消费账单（每日花费汇总）。
 *
 * 数据来源是本地余额账本（store.ts 的 balanceHistory）：每次成功读到某个
 * 钱包的余额就追加一条样本，这里把「上一个采样点 → 这一天最后一个采样点」
 * 的差额算成当天消费。金额是真实扣费，不是估算。
 *
 * 已知口径：
 *   1. 第一天的消费不算（没有前一天参照），所以第一天显示 0；
 *   2. 软件没运行的时段，花费会累积到下次运行的当天；
 *   3. 当天充过值时，充值会抵消消费（差额为负按 0 处理），当天会少计。
 * 这三点都会在界面上写明，不做「看起来更准」的假数据。
 */

const DAY_MS = 24 * 60 * 60 * 1000

export interface ReportProviderAmount {
  providerId: string
  name: string
  amount: number
}

export interface ReportDay {
  /** 本地日期 YYYY-MM-DD。 */
  date: string
  /** 当天合计消费（所选币种）。 */
  total: number
  byProvider: ReportProviderAmount[]
}

export interface DailyReport {
  currency: string
  /** 账本里出现过的币种，前端可切换。 */
  currencies: string[]
  /** 升序（最早 → 今天），长度 = 请求天数。 */
  days: ReportDay[]
  totals: { today: number; week: number; month: number; all: number }
  /** 所选区间内各厂商合计 —— 树状图 / 占比用。 */
  providerTotals: ReportProviderAmount[]
  /** 账本元信息：UI 用来提示「数据从哪天开始积累」。 */
  sampleCount: number
  firstSampleAt: number | null
  lastSampleAt: number | null
}

export interface UsageDay {
  date: string
  tokens: number
  cost: number
}

export interface UsageReport {
  available: boolean
  days: UsageDay[]
  /** 累计 token（MiMo 控制台给的累计值，原样展示）。 */
  totalToken: number | null
  /** 本月累计 token（按天差值求和）。 */
  monthToken: number | null
  todayToken: number
  todayCost: number
  /** 本月累计消费（MiMo 控制台原值）。 */
  monthCost: number | null
  /** 累计消费（MiMo 控制台原值）。 */
  totalCost: number | null
  lastSampleAt: number | null
}

// ===== 通用 token 用量（全厂商，来自本软件自身探测） =====

/** 某厂商在某天的探测 token 消耗。 */
export interface TokenProviderDay {
  providerId: string
  name: string
  prompt: number
  completion: number
  total: number
}

export interface TokenDay {
  date: string
  total: number
  byProvider: TokenProviderDay[]
}

export interface TokenReport {
  /** 升序（最早 → 今天），长度 = 请求天数。 */
  days: TokenDay[]
  todayToken: number
  weekToken: number
  monthToken: number
  allToken: number
  /** 所选区间内各厂商合计 —— 占比 / 排行用。 */
  providerTotals: TokenProviderDay[]
  sampleCount: number
  firstDay: string | null
  lastDay: string | null
}

function dateKey(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 今天 00:00 的毫秒时间戳（本地时区）。 */
function startOfToday(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function providerName(providerId: string): string {
  const custom = getCustomProviders().find((p) => p.id === providerId)
  if (custom) return custom.name
  const builtin = PROVIDERS.find((p) => p.id === providerId)
  if (builtin) return builtin.name
  if (providerId === 'mimo') return '小米 MiMo'
  return providerId
}

/** 钱包标识：账号级钱包整个账号一份，其他按「供应商 + 密钥序号」区分。 */
function walletKey(sample: BalanceSample): string {
  if (sample.accountScope || sample.keyIndex === -1) {
    // 账号级钱包必须按账号分开：MiMo 每个控制台账号各有一个钱包，混成一个桶会把
    // A 账号的余额下降算成 B 账号的消费（多账号用户账单会完全失真）。
    return `${sample.providerId}#account:${sample.accountId ?? 'unknown'}`
  }
  return `${sample.providerId}#${sample.keyIndex}`
}

function addAmount(
  buckets: Map<string, Map<string, number>>,
  date: string,
  providerId: string,
  amount: number
): void {
  if (amount <= 0) return
  let perProvider = buckets.get(date)
  if (!perProvider) {
    perProvider = new Map()
    buckets.set(date, perProvider)
  }
  perProvider.set(providerId, (perProvider.get(providerId) ?? 0) + amount)
}

/**
 * 把余额样本换算成「日期 → 供应商 → 当天消费」。
 * 逐钱包推进：先按天分桶、桶内按时间排序，再从前一天的收尾余额推出当天消费。
 */
function dailySpend(samples: BalanceSample[]): Map<string, Map<string, number>> {
  const wallets = new Map<string, Map<string, BalanceSample[]>>()
  for (const sample of samples) {
    const wkey = walletKey(sample)
    let days = wallets.get(wkey)
    if (!days) {
      days = new Map()
      wallets.set(wkey, days)
    }
    const dk = dateKey(sample.t)
    const bucket = days.get(dk)
    if (bucket) bucket.push(sample)
    else days.set(dk, [sample])
  }

  const spend = new Map<string, Map<string, number>>()
  for (const days of wallets.values()) {
    const sortedDays = [...days.keys()].sort()
    let baseline: number | null = null
    for (const dk of sortedDays) {
      const bucket = days.get(dk)!
      bucket.sort((a, b) => a.t - b.t)
      const last = bucket[bucket.length - 1]
      if (baseline === null) {
        // 首日没有更早的参照点：只统计当天自身的余额下降（记录开始之后的花费），
        // 这样刚启动不久也能看到当天的实时消耗，而不是一片 0。
        const first = bucket[0]
        const sameDayDelta = first.available - last.available
        if (sameDayDelta > 0) addAmount(spend, dk, last.providerId, sameDayDelta)
        baseline = last.available
        continue
      }
      const delta = baseline - last.available
      // 负数 = 当天充过值，无法把这天的消耗从充值里拆出来，按 0 计。
      if (delta > 0) addAmount(spend, dk, last.providerId, delta)
      baseline = last.available
    }
  }
  return spend
}

/** 从「日期 → 供应商 → 金额」里取某一天的总数。 */
function dayTotal(perProvider: Map<string, number> | undefined): number {
  if (!perProvider) return 0
  let sum = 0
  for (const v of perProvider.values()) sum += v
  return sum
}

/** 账本里出现次数最多的币种（大多数国内厂商都是 CNY）。 */
function dominantCurrency(samples: BalanceSample[]): string {
  const counts = new Map<string, number>()
  for (const s of samples) counts.set(s.currency, (counts.get(s.currency) ?? 0) + 1)
  let best = 'CNY'
  let bestCount = -1
  for (const [currency, count] of counts) {
    if (count > bestCount) {
      best = currency
      bestCount = count
    }
  }
  return best
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100
}

export function buildDailyReport(days: number, currency?: string): DailyReport {
  const dayCount = Math.max(1, Math.min(366, Math.floor(days) || 30))
  const all = getBalanceHistory()
  const currencies = [...new Set(all.map((s) => s.currency))].sort()
  const chosen =
    currency && currencies.includes(currency)
      ? currency
      : currencies.length > 0
        ? dominantCurrency(all)
        : 'CNY'

  const samples = all.filter((s) => s.currency === chosen)
  const spend = dailySpend(samples)
  const today = startOfToday()

  // 区间窗口（含今天），日期升序，缺数据的日子补 0。
  const windowDays: ReportDay[] = []
  for (let offset = dayCount - 1; offset >= 0; offset--) {
    const dk = dateKey(today - offset * DAY_MS)
    const perProvider = spend.get(dk)
    const byProvider: ReportProviderAmount[] = perProvider
      ? [...perProvider.entries()]
          .filter(([, amount]) => amount > 0)
          .map(([providerId, amount]) => ({
            providerId,
            name: providerName(providerId),
            amount: roundMoney(amount),
          }))
          .sort((a, b) => b.amount - a.amount)
      : []
    windowDays.push({ date: dk, total: roundMoney(dayTotal(perProvider)), byProvider })
  }

  const sumLastDays = (count: number): number => {
    let sum = 0
    for (let offset = 0; offset < count; offset++) {
      sum += dayTotal(spend.get(dateKey(today - offset * DAY_MS)))
    }
    return sum
  }

  // 本月：按本地自然月，从 1 号累积到今天。
  const firstOfMonth = new Date(today)
  firstOfMonth.setDate(1)
  firstOfMonth.setHours(0, 0, 0, 0)
  let monthSum = 0
  for (const [dk, perProvider] of spend) {
    const [y, m] = dk.split('-').map(Number)
    const monthStart = new Date(firstOfMonth)
    if (y === monthStart.getFullYear() && m === monthStart.getMonth() + 1) {
      monthSum += dayTotal(perProvider)
    }
  }

  let allSum = 0
  for (const perProvider of spend.values()) allSum += dayTotal(perProvider)

  // 树状图 / 占比：所选区间内各厂商合计。
  const providerSum = new Map<string, number>()
  for (const day of windowDays) {
    for (const row of day.byProvider) {
      providerSum.set(row.providerId, (providerSum.get(row.providerId) ?? 0) + row.amount)
    }
  }
  const providerTotals: ReportProviderAmount[] = [...providerSum.entries()]
    .map(([providerId, amount]) => ({
      providerId,
      name: providerName(providerId),
      amount: roundMoney(amount),
    }))
    .filter((row) => row.amount > 0)
    .sort((a, b) => b.amount - a.amount)

  const sortedSamples = [...samples].sort((a, b) => a.t - b.t)

  return {
    currency: chosen,
    currencies,
    days: windowDays,
    totals: {
      today: windowDays[windowDays.length - 1]?.total ?? 0,
      week: roundMoney(sumLastDays(7)),
      month: roundMoney(monthSum),
      all: roundMoney(allSum),
    },
    providerTotals,
    sampleCount: samples.length,
    firstSampleAt: sortedSamples.length > 0 ? sortedSamples[0].t : null,
    lastSampleAt: sortedSamples.length > 0 ? sortedSamples[sortedSamples.length - 1].t : null,
  }
}

export function buildUsageReport(days: number): UsageReport {
  const dayCount = Math.max(1, Math.min(366, Math.floor(days) || 30))
  const samples = getUsageHistory()
    .filter((s) => s.providerId === 'mimo')
    .sort((a, b) => a.t - b.t)

  if (samples.length === 0) {
    return {
      available: false,
      days: [],
      totalToken: null,
      monthToken: null,
      todayToken: 0,
      todayCost: 0,
      monthCost: null,
      totalCost: null,
      lastSampleAt: null,
    }
  }

  const buckets = new Map<string, UsageSample[]>()
  for (const sample of samples) {
    const dk = dateKey(sample.t)
    const bucket = buckets.get(dk)
    if (bucket) bucket.push(sample)
    else buckets.set(dk, [sample])
  }

  const perDay = new Map<string, { tokens: number; cost: number }>()
  let baseline: UsageSample | null = null
  for (const dk of [...buckets.keys()].sort()) {
    const bucket = buckets.get(dk)!
    bucket.sort((a, b) => a.t - b.t)
    const last = bucket[bucket.length - 1]
    if (baseline) {
      const tokens = last.totalToken - baseline.totalToken
      const cost = last.totalCost - baseline.totalCost
      perDay.set(dk, {
        tokens: tokens > 0 ? tokens : 0,
        cost: cost > 0 ? cost : 0,
      })
    } else {
      // 第一天没有前一天参照：用当天自身的增量，保证当场就能看到数字。
      const first = bucket[0]
      perDay.set(dk, {
        tokens: Math.max(0, last.totalToken - first.totalToken),
        cost: Math.max(0, last.totalCost - first.totalCost),
      })
    }
    baseline = last
  }

  const today = startOfToday()
  const windowDays: UsageDay[] = []
  for (let offset = dayCount - 1; offset >= 0; offset--) {
    const dk = dateKey(today - offset * DAY_MS)
    const row = perDay.get(dk)
    windowDays.push({ date: dk, tokens: row?.tokens ?? 0, cost: roundMoney(row?.cost ?? 0) })
  }

  const firstOfMonth = new Date(today)
  firstOfMonth.setDate(1)
  firstOfMonth.setHours(0, 0, 0, 0)
  let monthTokens = 0
  for (const [dk, row] of perDay) {
    const [y, m] = dk.split('-').map(Number)
    if (y === firstOfMonth.getFullYear() && m === firstOfMonth.getMonth() + 1) {
      monthTokens += row.tokens
    }
  }

  const latest = samples[samples.length - 1]
  const todayRow = perDay.get(dateKey(today))

  return {
    available: true,
    days: windowDays,
    totalToken: latest.totalToken,
    monthToken: monthTokens,
    todayToken: todayRow?.tokens ?? 0,
    todayCost: roundMoney(todayRow?.cost ?? 0),
    monthCost: latest.monthCost,
    totalCost: latest.totalCost,
    lastSampleAt: latest.t,
  }
}

/**
 * 通用 token 用量报表 —— 全厂商、全用户可用。
 *
 * 数据只来自本软件自己发起的探测请求（探测响应体里的 usage 字段），按天 ×
 * 厂商累加。它统计的是「这个监测工具自己烧了多少 token」，不是厂商账单里
 * 的总用量（那需要每个厂商各自的账单接口，目前只有 MiMo 控制台有）。
 * 界面上必须写明这一点，不能冒充总用量。
 */
export function buildTokenReport(days: number): TokenReport {
  const dayCount = Math.max(1, Math.min(366, Math.floor(days) || 30))
  const table = getProbeUsage()

  // date -> providerId -> 累计
  const perDay = new Map<string, Map<string, { prompt: number; completion: number; total: number }>>()
  for (const [dk, providers] of Object.entries(table)) {
    const row = new Map<string, { prompt: number; completion: number; total: number }>()
    for (const [providerId, usage] of Object.entries(providers)) {
      if (!usage || !Number.isFinite(usage.total)) continue
      row.set(providerId, {
        prompt: usage.prompt || 0,
        completion: usage.completion || 0,
        total: usage.total || 0,
      })
    }
    if (row.size > 0) perDay.set(dk, row)
  }

  const sortedDates = [...perDay.keys()].sort()
  const today = startOfToday()
  const windowDays: TokenDay[] = []
  for (let offset = dayCount - 1; offset >= 0; offset--) {
    const dk = dateKey(today - offset * DAY_MS)
    const row = perDay.get(dk)
    const byProvider: TokenProviderDay[] = row
      ? [...row.entries()]
          .map(([providerId, u]) => ({
            providerId,
            name: providerName(providerId),
            prompt: u.prompt,
            completion: u.completion,
            total: u.total,
          }))
          .filter((p) => p.total > 0)
          .sort((a, b) => b.total - a.total)
      : []
    windowDays.push({
      date: dk,
      total: byProvider.reduce((sum, p) => sum + p.total, 0),
      byProvider,
    })
  }

  // 各厂商合计（窗口内）
  const providerSum = new Map<string, TokenProviderDay>()
  for (const day of windowDays) {
    for (const p of day.byProvider) {
      const cur = providerSum.get(p.providerId)
      if (cur) {
        cur.prompt += p.prompt
        cur.completion += p.completion
        cur.total += p.total
      } else {
        providerSum.set(p.providerId, { ...p })
      }
    }
  }
  const providerTotals = [...providerSum.values()].sort((a, b) => b.total - a.total)

  const sumLastDays = (n: number): number => {
    const slice = windowDays.slice(-Math.min(n, windowDays.length))
    return slice.reduce((sum, d) => sum + d.total, 0)
  }
  const firstOfMonth = new Date(today)
  firstOfMonth.setDate(1)
  firstOfMonth.setHours(0, 0, 0, 0)
  let monthToken = 0
  for (const [dk, row] of perDay) {
    const [y, m] = dk.split('-').map(Number)
    if (y === firstOfMonth.getFullYear() && m === firstOfMonth.getMonth() + 1) {
      for (const u of row.values()) monthToken += u.total
    }
  }

  let sampleCount = 0
  for (const row of perDay.values()) sampleCount += row.size

  return {
    days: windowDays,
    todayToken: windowDays[windowDays.length - 1]?.total ?? 0,
    weekToken: sumLastDays(7),
    monthToken,
    allToken: sortedDates.reduce((sum, dk) => {
      let s = 0
      for (const u of perDay.get(dk)!.values()) s += u.total
      return sum + s
    }, 0),
    providerTotals,
    sampleCount,
    firstDay: sortedDates[0] ?? null,
    lastDay: sortedDates[sortedDates.length - 1] ?? null,
  }
}

function csvCell(value: string | number): string {
  const text = String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** 账单 CSV（宽表 + token 用量两段），带 BOM 以便 Excel 直接打开。 */
export function buildReportCsv(days: number, currency?: string): string {
  const report = buildDailyReport(days, currency)
  const usage = buildUsageReport(days)
  const rows: string[] = []
  const providerColumns = report.providerTotals.map((p) => p.name)
  const providerIds = report.providerTotals.map((p) => p.providerId)

  rows.push(
    ['日期', `合计(${report.currency})`, ...providerColumns].map(csvCell).join(',')
  )
  // 明细按时间正序导出，和界面表格相反（表格最新在上，文件里方便拉公式）。
  for (const day of report.days) {
    const cells: (string | number)[] = [day.date, day.total]
    for (const providerId of providerIds) {
      const hit = day.byProvider.find((row) => row.providerId === providerId)
      cells.push(hit ? hit.amount : 0)
    }
    rows.push(cells.map(csvCell).join(','))
  }
  // 合计行必须和上面的明细窗口对齐：以前用 totals.all（全部历史），表里明明只有
  // 最近 30 天的行，合计却是几年的总额，一眼就看得出对不上。
  const windowTotal = roundMoney(report.days.reduce((sum, day) => sum + day.total, 0))
  rows.push(
    ['合计', windowTotal, ...report.providerTotals.map((p) => p.amount)]
      .map(csvCell)
      .join(',')
  )

  if (usage.available) {
    rows.push('')
    rows.push('小米 MiMo token 用量（来自控制台累计值差分）')
    rows.push(['日期', 'token', '花费(元)'].map(csvCell).join(','))
    for (const day of usage.days) {
      rows.push([day.date, day.tokens, day.cost].map(csvCell).join(','))
    }
    // 「累计」应该是全时段累计花费；以前这里写的是 monthCost（本月），列名骗人。
    rows.push(
      ['累计', usage.totalToken ?? 0, usage.totalCost ?? 0].map(csvCell).join(',')
    )
  }

  return '\uFEFF' + rows.join('\r\n') + '\r\n'
}
