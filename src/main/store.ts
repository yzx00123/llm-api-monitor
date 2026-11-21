import Store from 'electron-store'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { gunzipSync, gzipSync } from 'zlib'

/**
 * MiMo 控制台会话：一个小米账号一条。
 *
 * 余额是「控制台账号」级的，不是 sk- 密钥级的 —— 同账号的多把 key 共用一份钱包，
 * 不同账号各是各的。老版本只存了一条全局 mimoCookie，哪个账号后登录就全摊哪个
 * 账号的钱（用户实测：连了 7002 的账号，7001 的卡片也显示 7002 的余额）。改成按
 * 账号存会话后，每把 key 用它自己账号的 cookie 查余额，互不串号。
 */
export interface MimoSession {
  /** 控制台 userId（cookie 里的 userId）—— 同一个小米账号只有一条。 */
  accountId: string
  /** 该账号名下密钥的尾 6 位（来自控制台 GET /api/v1/apiKeys）。 */
  keySuffixes: string[]
  /** 控制台会话 cookie：api-platform_serviceToken=…; userId=… */
  cookie: string
  /** 最后绑定 / 验证时间。 */
  updatedAt: number
  /** 用户是从哪把密钥的卡片点「连接控制台」建立这条会话的（尾 6 位）。 */
  boundBy?: string
}

interface StoreSchema {
  apiKeys: Record<string, string[]>
  /** Full key -> custom display name (e.g. "公司号"). Survives reordering. */
  keyLabels: Record<string, string>
  /** 老版本遗留的单条 MiMo cookie，仅用于迁移（见 migrateMimoSessions）。 */
  mimoCookie: string
  /** MiMo 控制台会话，按小米账号隔离，多个账号可以同时存在。 */
  mimoSessions: MimoSession[]
  customProviders: CustomProvider[]
  /** Wallet readings, used to build the daily spending report (账单). */
  balanceHistory: BalanceSample[]
  /** MiMo console cumulative usage readings (token + cost counters). */
  usageHistory: UsageSample[]
  /** Per-day token counts consumed by this app's own probes, per provider. */
  probeUsage: Record<string, Record<string, ProbeUsageDay>>
  /**
   * 已经弹过「余额不足」提醒的密钥（statusKey = `providerId#keyIndex`）。
   * 持久化到配置里，重启软件也不会重复弹；充值恢复（refilled）后移除。
   */
  brokeAlerted: string[]
  settings: {
    intervalMs: number
    enabled: boolean
    /** Auto-start monitoring when the app opens. */
    autoStart: boolean
    /** One-time onboarding dialog has been dismissed. */
    onboarded: boolean
    /** UI theme: light, dark, or follow the OS. */
    theme: 'light' | 'dark' | 'system'
    /** Probe text sent on every latency check (and by 测延迟). */
    probeText: string
    /** max_tokens for latency probes. Small keeps the check cheap. */
    probeMaxTokens: number
    /**
     * Optional model override for latency probes.
     * Empty = use the provider's default probe model (models[0]).
     * Note: a single override may not exist on every provider — leave empty
     * unless you only monitor one vendor.
     */
    probeModel: string
    /** Desktop notifications when a key goes down / runs out of money. */
    alertsEnabled: boolean
    /** Play a sound together with alert notifications. */
    alertSound: boolean
    /** Also notify when a key recovers or gets refilled. */
    alertOnRecovery: boolean
    /** Close button hides to tray and keeps monitoring instead of quitting. */
    minimizeToTray: boolean
  }
}

interface CustomProvider {
  id: string
  name: string
  company: string
  baseUrl: string
  balanceUrl?: string
  models: string[]
  protocol: 'openai' | 'anthropic' | 'gemini'
  category: 'international' | 'china' | 'aggregator' | 'custom'
  /** Optional homepage / docs link shown in the provider form. */
  website?: string
  /** Optional free-form note (公司专用账号 etc). */
  note?: string
  createdAt: number
  updatedAt: number
}

/**
 * 消费账单用的余额快照。
 *
 * 余额接口只给「此刻的钱包余额」，没有任何厂商提供按天账单（MiMo 控制台是
 * 例外，但也只是累计用量）。所以每日消费只能由余额差值推导：每次成功读到
 * 余额就追加一条样本，report.ts 把相邻样本换算成「当天花了多少」。
 * 数据全部留在本机，不联网、不上传。
 */
export interface BalanceSample {
  /** 采样时间（毫秒时间戳）。 */
  t: number
  providerId: string
  /** 同一供应商下的第几个密钥；-1 = 账号级钱包（MiMo 控制台，不按密钥区分）。 */
  keyIndex: number
  currency: string
  available: number
  /** 账号级钱包（一个登录号一份余额，多个密钥共用）。 */
  accountScope?: boolean
  /** 账号级钱包所属的控制台账号 id（MiMo userId）；多账号必须分开记账。 */
  accountId?: string
}

/** MiMo 控制台的累计用量样本（token 与金额都是累计值，按天做差值即可）。 */
export interface UsageSample {
  t: number
  providerId: string
  totalToken: number
  inputToken: number
  outputToken: number
  cacheToken: number
  totalCost: number
  monthCost: number
}

/**
 * 某一天、某个厂商的探测 token 消耗（按天聚合的稀疏表）。
 * 数据只来自本软件自己发起的探测请求，不是厂商账单里的总用量。
 */
export interface ProbeUsageDay {
  prompt: number
  completion: number
  total: number
}

/** 本地账本保留天数：更早的明细不用看了。 */
const HISTORY_DAYS = 200
/** 这段时间内保留每一次读数；更早的每天每个钱包只留最后一条（账单只需要收尾值）。 */
const RAW_DAYS = 14
/** 硬上限，防止极端情况把账本撑爆。 */
const MAX_SAMPLES = 20000
/** 同一个钱包、金额没变的读数在这个窗口内只记一条（去重轮询噪声）。 */
const SAMPLE_DEDUPE_MS = 10 * 60 * 1000
/** 账本文件格式版本；不认识的版本直接重建（这是本机流水，不是权威数据）。 */
const HISTORY_FORMAT = 1

/**
 * 账本单独存一个 gzip 文件，不再塞进 electron-store 的主配置。
 *
 * 原来三份流水全在主配置 JSON 里：用户用两天就 160 KB（余额样本 89 KB / 用量样本
 * 29 KB），每次探测都触发整文件重写；而数据重复度极高（providerId、currency 反复
 * 出现），gzip 能压掉 90% 以上。现在：
 *   · 明细搬进 `llm-monitor-config.history.json.gz`（gzip 后一般十几 KB）；
 *   · 主配置只剩密钥 / 会话 / 设置，回到几 KB，坏了人工也能看能改；
 *   · 落盘用「写临时文件 + rename」，不会留下写一半的坏 JSON；
 *   · 老版本留在主配置里的三份流水第一次落盘后自动删掉（迁移不丢数据）。
 */
interface HistoryFile {
  v: number
  balance: BalanceSample[]
  usage: UsageSample[]
  probeUsage: Record<string, Record<string, ProbeUsageDay>>
}

function historyPath(): string {
  return store.path.replace(/\.json$/i, '') + '.history.json.gz'
}

/** 钱包标识（与 report.ts 的口径一致：账号级钱包按 accountId 分开）。 */
function walletOf(row: BalanceSample): string {
  if (row.accountScope || row.keyIndex === -1) {
    return `${row.providerId}#account:${row.accountId ?? 'unknown'}`
  }
  return `${row.providerId}#${row.keyIndex}`
}

/**
 * 分两级裁剪余额样本：最近 RAW_DAYS 天原样保留；更早的每天每个钱包只留最后一条
 * —— 账单是「前一天收尾余额 − 今天收尾余额」，中间的读数对结果没有贡献。
 */
function pruneBalance(rows: BalanceSample[]): BalanceSample[] {
  const now = Date.now()
  const rawCutoff = now - RAW_DAYS * 86_400_000
  const hardCutoff = now - HISTORY_DAYS * 86_400_000
  const recent: BalanceSample[] = []
  const dailyLast = new Map<string, BalanceSample>()
  for (const row of rows) {
    if (row.t < hardCutoff) continue
    if (row.t >= rawCutoff) {
      recent.push(row)
      continue
    }
    // rows 按时间追加，同一 key 后写覆盖先写 = 「当天最后一条」。
    dailyLast.set(`${walletOf(row)}|${dateKey(row.t)}`, row)
  }
  const kept = [...recent, ...dailyLast.values()].sort((a, b) => a.t - b.t)
  return kept.length > MAX_SAMPLES ? kept.slice(kept.length - MAX_SAMPLES) : kept
}

/** 用量样本同理：最近 RAW_DAYS 天留全量，更早的每天只留收尾值（累计值做差即可）。 */
function pruneUsage(rows: UsageSample[]): UsageSample[] {
  const now = Date.now()
  const rawCutoff = now - RAW_DAYS * 86_400_000
  const hardCutoff = now - HISTORY_DAYS * 86_400_000
  const recent: UsageSample[] = []
  const dailyLast = new Map<string, UsageSample>()
  for (const row of rows) {
    if (row.t < hardCutoff) continue
    if (row.t >= rawCutoff) {
      recent.push(row)
      continue
    }
    dailyLast.set(`${row.providerId}|${dateKey(row.t)}`, row)
  }
  return [...recent, ...dailyLast.values()].sort((a, b) => a.t - b.t)
}

/**
 * 落盘前的紧凑化：时间戳存「秒」（13 位 → 10 位），金额只留到分。
 * 余额本来就只有两位小数，之前直接存浮点结果，会带出 0.9299999999999999 这种尾巴。
 */
function encodeBalance(rows: BalanceSample[]): BalanceSample[] {
  return rows.map((row) => ({
    ...row,
    t: Math.floor(row.t / 1000),
    available: Math.round(row.available * 100) / 100,
  }))
}

function decodeBalance(rows: BalanceSample[]): BalanceSample[] {
  return rows.map((row) => ({
    ...row,
    // 兼容老格式：1e12 以下视为「秒」（现在约 1.8e9），否则就是毫秒。
    t: row.t < 1e12 ? row.t * 1000 : row.t,
  }))
}

function encodeUsage(rows: UsageSample[]): UsageSample[] {
  return rows.map((row) => ({
    ...row,
    t: Math.floor(row.t / 1000),
    totalCost: Math.round(row.totalCost * 100) / 100,
    monthCost: Math.round(row.monthCost * 100) / 100,
  }))
}

function decodeUsage(rows: UsageSample[]): UsageSample[] {
  return rows.map((row) => ({ ...row, t: row.t < 1e12 ? row.t * 1000 : row.t }))
}

/*
 * 采样数据的内存副本 + 合批落盘（500ms 合并一次 gzip 写盘）。
 */
let balanceCache: BalanceSample[] | null = null
let usageCache: UsageSample[] | null = null
let probeUsageCache: Record<string, Record<string, ProbeUsageDay>> | null = null
let sampleFlushTimer: ReturnType<typeof setTimeout> | null = null
let historyLoaded = false
/** 本次进程是否从主配置里接管了老流水（迁移完要把配置里那三坨大数组删掉）。 */
let legacyHistoryPending = false

function ensureHistoryLoaded(): void {
  if (historyLoaded) return
  historyLoaded = true
  try {
    const file = historyPath()
    if (existsSync(file)) {
      const parsed = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as HistoryFile
      if (parsed.v === HISTORY_FORMAT) {
        balanceCache = decodeBalance(parsed.balance ?? [])
        usageCache = decodeUsage(parsed.usage ?? [])
        probeUsageCache = parsed.probeUsage ?? {}
        return
      }
      console.warn('[history] unknown format, rebuilding:', parsed.v)
    }
  } catch (err) {
    console.error('[history] load failed, starting empty:', err)
  }
  // 没有独立账本文件（或格式不认识）：从主配置里接管老数据。
  balanceCache = store.get('balanceHistory', [])
  usageCache = store.get('usageHistory', [])
  probeUsageCache = store.get('probeUsage', {})
  legacyHistoryPending =
    (balanceCache?.length ?? 0) > 0 ||
    (usageCache?.length ?? 0) > 0 ||
    Object.keys(probeUsageCache ?? {}).length > 0
}

function scheduleSampleFlush(): void {
  if (sampleFlushTimer) return
  sampleFlushTimer = setTimeout(syncFlushSamples, 500)
  // 不让这个定时器拖住进程退出；退出前 before-quit 会显式 flush 一次。
  sampleFlushTimer.unref?.()
}

/** 把攒着的采样一次性写盘（gzip + 原子替换）。退出前调用，别丢最后几秒的账。 */
export function syncFlushSamples(): void {
  if (sampleFlushTimer) {
    clearTimeout(sampleFlushTimer)
    sampleFlushTimer = null
  }
  ensureHistoryLoaded()
  const payload: HistoryFile = {
    v: HISTORY_FORMAT,
    balance: encodeBalance(pruneBalance(balanceCache ?? [])),
    usage: encodeUsage(pruneUsage(usageCache ?? [])),
    probeUsage: probeUsageCache ?? {},
  }
  try {
    const file = historyPath()
    const tmp = `${file}.tmp`
    // level 9：账本最多一两百 KB，而且几秒才写一次，多花几毫秒换更小体积很值。
    writeFileSync(tmp, gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 9 }))
    renameSync(tmp, file)
    if (legacyHistoryPending) {
      // 迁移完成：把主配置里的三坨大数组删掉，配置文件立刻从几百 KB 回到几 KB。
      store.delete('balanceHistory')
      store.delete('usageHistory')
      store.delete('probeUsage')
      legacyHistoryPending = false
    }
  } catch (err) {
    console.error('[history] flush failed:', err)
  }
}

/** 从后往前找最后一条匹配样本（比 reverse() 省一次数组复制）。 */
function findLast<T>(rows: T[], match: (row: T) => boolean): T | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (match(rows[i])) return rows[i]
  }
  return undefined
}

export function getBalanceHistory(): BalanceSample[] {
  ensureHistoryLoaded()
  if (!balanceCache) balanceCache = []
  return balanceCache
}

/** 追加一条余额样本；同钱包同金额的重复读数会被折叠。 */
export function appendBalanceSample(sample: BalanceSample): void {
  if (!Number.isFinite(sample.available)) return
  const rows = getBalanceHistory()
  const last = findLast(
    rows,
    (row) =>
      row.providerId === sample.providerId &&
      row.keyIndex === sample.keyIndex &&
      row.accountId === sample.accountId
  )
  if (
    last &&
    last.currency === sample.currency &&
    last.available === sample.available &&
    sample.t - last.t < SAMPLE_DEDUPE_MS
  ) {
    return
  }
  rows.push(sample)
  // 裁剪留到落盘时做（pruneBalance），这里只防止内存无限增长。
  if (rows.length > MAX_SAMPLES * 2) rows.splice(0, rows.length - MAX_SAMPLES)
  scheduleSampleFlush()
}

export function getUsageHistory(): UsageSample[] {
  ensureHistoryLoaded()
  if (!usageCache) usageCache = []
  return usageCache
}

/** 追加一条累计用量样本；累计值没变时不重复记录。 */
export function appendUsageSample(sample: UsageSample): void {
  const rows = getUsageHistory()
  const last = findLast(rows, (row) => row.providerId === sample.providerId)
  if (
    last &&
    last.totalToken === sample.totalToken &&
    last.totalCost === sample.totalCost &&
    sample.t - last.t < SAMPLE_DEDUPE_MS
  ) {
    return
  }
  rows.push(sample)
  if (rows.length > MAX_SAMPLES * 2) rows.splice(0, rows.length - MAX_SAMPLES)
  scheduleSampleFlush()
}

/** 本地日期键（与 report.ts 的 dateKey 一致：本地时区 YYYY-MM-DD）。 */
function dateKey(t: number): string {
  const d = new Date(t)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export function getProbeUsage(): Record<string, Record<string, ProbeUsageDay>> {
  ensureHistoryLoaded()
  if (!probeUsageCache) probeUsageCache = {}
  return probeUsageCache
}

/**
 * 累加一次探测消耗的 token（按天 × 厂商聚合成稀疏表）。
 * 同时清理超出 HISTORY_DAYS 的旧日期，防止配置文件无限增长。
 */
export function appendProbeUsage(
  providerId: string,
  t: number,
  usage: { prompt: number; completion: number; total: number }
): void {
  if (!Number.isFinite(usage.total) || usage.total <= 0) return
  const table = getProbeUsage()
  const day = dateKey(t)
  const perProvider = table[day] ?? {}
  const cur = perProvider[providerId] ?? { prompt: 0, completion: 0, total: 0 }
  perProvider[providerId] = {
    prompt: cur.prompt + (Number.isFinite(usage.prompt) ? usage.prompt : 0),
    completion: cur.completion + (Number.isFinite(usage.completion) ? usage.completion : 0),
    total: cur.total + usage.total,
  }
  table[day] = perProvider
  const cutoff = dateKey(Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000)
  for (const key of Object.keys(table)) {
    if (key < cutoff) delete table[key]
  }
  scheduleSampleFlush()
}

const store = new Store<StoreSchema>({
  name: 'llm-monitor-config',
  defaults: {
    apiKeys: {},
    keyLabels: {},
    mimoCookie: '',
    mimoSessions: [],
    customProviders: [],
    balanceHistory: [],
    usageHistory: [],
    probeUsage: {},
    brokeAlerted: [],
    settings: {
      intervalMs: 10000,
      enabled: false,
      autoStart: true,
      onboarded: false,
      theme: 'system',
      probeText: '请用一句话介绍你自己。',
      probeMaxTokens: 16,
      probeModel: '',
      alertsEnabled: true,
      alertSound: true,
      alertOnRecovery: true,
      minimizeToTray: true,
    },
  },
})

/** 已经弹过「余额不足」提醒的密钥 statusKey 列表（持久化，重启不重复弹）。 */
export function getBrokeAlerted(): string[] {
  return store.get('brokeAlerted', [])
}

/** 记住某密钥已经弹过没钱提醒（只在真正弹出通知后调用）。 */
export function addBrokeAlerted(id: string): void {
  const list = store.get('brokeAlerted', [])
  if (!list.includes(id)) store.set('brokeAlerted', [...list, id])
}

/** 充值恢复（refilled）后解除记忆，下次再没钱才会重新提醒。 */
export function clearBrokeAlerted(id: string): void {
  const list = store.get('brokeAlerted', [])
  if (list.includes(id)) store.set('brokeAlerted', list.filter((x) => x !== id))
}

export function getApiKeys(): Record<string, string[]> {
  return store.get('apiKeys', {})
}

export function setApiKeys(keys: Record<string, string[]>): void {
  store.set('apiKeys', keys)
}

export function getKeyLabels(): Record<string, string> {
  return store.get('keyLabels', {})
}

export function setKeyLabel(key: string, label: string): void {
  const labels = store.get('keyLabels', {})
  if (label.trim()) labels[key] = label.trim()
  else delete labels[key]
  store.set('keyLabels', labels)
}

export function getMimoCookie(): string {
  return store.get('mimoCookie', '')
}

export function setMimoCookie(cookie: string): void {
  store.set('mimoCookie', cookie)
}

/** 所有已连接的控制台账号（含各自 cookie 与名下密钥尾号）。 */
export function getMimoSessions(): MimoSession[] {
  return store.get('mimoSessions', [])
}

/** 按 accountId 写入会话：同一个小米账号只有一条，多个账号可并存。 */
export function saveMimoSession(session: MimoSession): void {
  const list = store.get('mimoSessions', [])
  const idx = list.findIndex((s) => s.accountId === session.accountId)
  if (idx === -1) list.push(session)
  else list[idx] = { ...list[idx], ...session }
  store.set('mimoSessions', list)
}

export function removeMimoSession(accountId: string): void {
  const list = store.get('mimoSessions', [])
  const next = list.filter((s) => s.accountId !== accountId)
  if (next.length !== list.length) store.set('mimoSessions', next)
}

/**
 * 这把密钥（尾 6 位）属于哪个控制台账号。
 * 先认「这次登录明确点的尾号」（boundBy），再按账号名下的 key 尾号列表匹配；
 * 老版本迁移过来的会话没有列表，只能退回 boundBy。
 */
export function findMimoSessionBySuffix(suffix: string): MimoSession | undefined {
  const list = getMimoSessions()
  return (
    list.find((s) => s.boundBy === suffix) ??
    list.find((s) => s.keySuffixes.includes(suffix))
  )
}

/**
 * 老版本只存一条全局 mimoCookie。升级后把它迁成一条会话，否则老用户「明明连过
 * 控制台却突然要重新登录」。账号名下的 key 尾号等第一次查余额时再补拉。
 */
export function migrateMimoSessions(): void {
  try {
    const legacy = store.get('mimoCookie', '')
    if (!legacy) return
    // 已经有会话说明迁移过了（或用户重新登录过）：把老字段清掉，否则用户删光
    // 会话后它会在下次启动时「复活」一个早就失效的账号。
    if (store.get('mimoSessions', []).length > 0) {
      store.set('mimoCookie', '')
      return
    }
    const m = /(?:^|;\s*)userId=([^;]+)/.exec(legacy)
    let accountId = `legacy-${Date.now()}`
    if (m) {
      try {
        accountId = decodeURIComponent(m[1])
      } catch {
        // cookie 里的 userId 没做 URL 编码时 decodeURIComponent 会抛 URIError
        accountId = m[1]
      }
    }
    store.set('mimoSessions', [
      { accountId, cookie: legacy, keySuffixes: [], updatedAt: Date.now() },
    ])
    store.set('mimoCookie', '')
  } catch (err) {
    // 迁移失败绝不能抛到 whenReady 外面：那样窗口都建不出来，双击图标毫无反应。
    console.error('[mimo] session migration failed:', err)
  }
}

export function addApiKey(providerId: string, keys: string[]): void {
  const current = store.get('apiKeys', {})
  const existing = current[providerId] || []
  const merged = [...existing]
  for (const key of keys) {
    if (!merged.includes(key)) merged.push(key)
  }
  current[providerId] = merged
  store.set('apiKeys', current)
}

export function removeApiKey(providerId: string, keyIndex: number): void {
  const current = store.get('apiKeys', {})
  const keys = current[providerId] || []
  keys.splice(keyIndex, 1)
  if (keys.length === 0) {
    delete current[providerId]
  } else {
    current[providerId] = keys
  }
  store.set('apiKeys', current)

  // 历史余额样本是按 keyIndex 记账的：删掉一把 key 之后后面的索引整体前移，旧样本
  // 会被算到「另一把 key」的钱包头上（账单里凭空多出消费）。这里同步前移并丢掉
  // 属于被删那把 key 的样本，保证账本和新索引一一对应。
  const rows = getBalanceHistory()
  let changed = false
  const kept: BalanceSample[] = []
  for (const row of rows) {
    if (row.providerId !== providerId || row.keyIndex < 0) {
      kept.push(row)
      continue
    }
    if (row.keyIndex === keyIndex) {
      changed = true
      continue
    }
    if (row.keyIndex > keyIndex) {
      kept.push({ ...row, keyIndex: row.keyIndex - 1 })
      changed = true
      continue
    }
    kept.push(row)
  }
  if (changed) {
    balanceCache = kept
    scheduleSampleFlush()
  }
}

export function getCustomProviders(): CustomProvider[] {
  return store.get('customProviders', [])
}

export function addCustomProvider(provider: Omit<CustomProvider, 'createdAt' | 'updatedAt'>): CustomProvider {
  const providers = store.get('customProviders', [])
  const newProvider: CustomProvider = {
    ...provider,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  providers.push(newProvider)
  store.set('customProviders', providers)
  return newProvider
}

export function updateCustomProvider(id: string, updates: Partial<Omit<CustomProvider, 'id' | 'createdAt'>>): CustomProvider {
  const providers = store.get('customProviders', [])
  const idx = providers.findIndex((p) => p.id === id)
  if (idx === -1) throw new Error('Provider not found')
  const updated = { ...providers[idx], ...updates, updatedAt: Date.now() }
  providers[idx] = updated
  store.set('customProviders', providers)
  return updated
}

export function deleteCustomProvider(id: string): void {
  const providers = store.get('customProviders', [])
  const filtered = providers.filter((p) => p.id !== id)
  store.set('customProviders', filtered)
  const keys = store.get('apiKeys', {})
  delete keys[id]
  store.set('apiKeys', keys)
}

export type AppSettings = {
  intervalMs: number
  enabled: boolean
  autoStart: boolean
  onboarded: boolean
  theme: 'light' | 'dark' | 'system'
  /** Probe text sent on every latency check (and by 测延迟). */
  probeText: string
  /** max_tokens for latency probes. Small keeps the check cheap. */
  probeMaxTokens: number
  /** Optional model override; empty = provider default (models[0]). */
  probeModel: string
  /** Desktop notifications when a key goes down / runs out of money. */
  alertsEnabled: boolean
  /** Play a sound together with alert notifications. */
  alertSound: boolean
  /** Also notify when a key recovers or gets refilled. */
  alertOnRecovery: boolean
  /** Close button hides to tray and keeps monitoring instead of quitting. */
  minimizeToTray: boolean
}

const SETTINGS_DEFAULTS: AppSettings = {
  intervalMs: 10000,
  enabled: false,
  autoStart: true,
  onboarded: false,
  theme: 'system',
  probeText: '请用一句话介绍你自己。',
  // Small on purpose: probes measure latency, not generation quality.
  // 16 tokens is enough for a first reply and keeps every check cheap.
  probeMaxTokens: 16,
  probeModel: '',
  alertsEnabled: true,
  alertSound: true,
  alertOnRecovery: true,
  minimizeToTray: true,
}

export function getSettings(): AppSettings {
  // Spread defaults under the stored object: installs upgraded from older
  // versions have a settings blob without the newer keys — without the merge
  // those read as undefined (e.g. probeText undefined → probe falls back to Hi).
  return { ...SETTINGS_DEFAULTS, ...store.get('settings', SETTINGS_DEFAULTS) }
}

export function updateSettings(updates: Partial<AppSettings>): void {
  const current = store.get('settings', SETTINGS_DEFAULTS)
  store.set('settings', { ...current, ...updates })
}
