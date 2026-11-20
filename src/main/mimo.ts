import { BrowserWindow, session } from 'electron'
import type { Session } from 'electron'
import {
  findMimoSessionBySuffix,
  getMimoSessions,
  removeMimoSession,
  saveMimoSession,
  type MimoSession,
} from './store'
import type { BalanceInfo } from './monitor'

/**
 * Xiaomi MiMo console balance.
 *
 * The sk- API key cannot query balance (all /v1/* endpoints 404). The only
 * source is the web console session cookie against:
 *   GET https://platform.xiaomimimo.com/api/v1/tokenPlan/usage
 * Cookies required: api-platform_serviceToken + userId (domain xiaomimimo.com).
 * Response: { code, data: { usage: { items: [{ name, used, limit }] } } },
 * plan row name = 'plan_total_token'. Cookies expire ~24h → API returns 401.
 *
 * Login starts at Xiaomi's DOMESTIC SSO (account.xiaomi.com — China edge,
 * fast) instead of the Singapore-hosted platform homepage (slow JS from CN).
 * After the cookie lands we jump to the console (token-plan) page.
 *
 * Network split (verified 2026-11-07):
 *   mimo.mi.com ................ China edge, fast (docs/home)
 *   account.xiaomi.com .......... China edge, fast (SSO)
 *   platform.xiaomimimo.com ..... Singapore edge; the HTML/API are OK from CN
 *                                but the big SPA chunk is ~18KB/s → needs VPN.
 */

const CONSOLE_URL = 'https://platform.xiaomimimo.com/console'
/**
 * 控制台接口地址。默认走官方域名；MIMO_*_URL 只是给自动化测试留的后门 —— 指到
 * 本地假控制台，就能在不碰真实小米账号的前提下验证「按账号隔离余额」的逻辑。
 */
const BALANCE_URL =
  process.env.MIMO_BALANCE_URL?.trim() || 'https://platform.xiaomimimo.com/api/v1/balance'
const USAGE_URL =
  process.env.MIMO_USAGE_URL?.trim() || 'https://platform.xiaomimimo.com/api/v1/usage'
const APIKEYS_URL =
  process.env.MIMO_APIKEYS_URL?.trim() || 'https://platform.xiaomimimo.com/api/v1/apiKeys'
const COOKIE_NAMES = new Set(['api-platform_serviceToken', 'userId'])
const POLL_MS = 800
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

/** MiMo 控制台累计用量（token 均为累计值，金额同理）。 */
export interface MimoUsage {
  totalToken: number
  inputToken: number
  outputToken: number
  cacheToken: number
  /** 开户至今累计消费金额（元）。 */
  totalCost: number
  /** 自然月累计消费金额（元）。 */
  monthCost: number
}

/**
 * Ask the balance API for a fresh SSO entry URL. The 401 body carries a
 * signed callback into account.xiaomi.com (domestic); the sign is bound to
 * this endpoint so it cannot be forged or swapped for another followup.
 * Fallback: the public console page (has its own login button).
 */
async function getSsoLoginUrl(): Promise<string> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 6000)
    try {
      const resp = await fetch(BALANCE_URL, { signal: controller.signal })
      const body = await resp.text()
      const data = JSON.parse(body) as { loginUrl?: string }
      if (typeof data.loginUrl === 'string' && data.loginUrl.includes('account.xiaomi.com')) {
        return data.loginUrl
      }
    } finally {
      clearTimeout(timer)
    }
  } catch {
    // fall through to console URL
  }
  return CONSOLE_URL
}

/**
 * Cookie header for the balance API, or '' when not (yet) logged in.
 *
 * NEVER join every matching jar entry: Electron can hold several
 * `api-platform_serviceToken` rows (different path/domain, leftover from a
 * previous wrong-account login). Concatenating them sends duplicate Cookie
 * names and the server may honour the wrong session. Pick exactly one
 * serviceToken + one userId, preferring the host-only platform domain and
 * the most recently updated row.
 */
async function readSessionCookie(sess: Session): Promise<string> {
  const cookies = await sess.cookies.get({})
  const pool = cookies.filter(
    (c) => COOKIE_NAMES.has(c.name) && (c.domain ?? '').includes('xiaomimimo')
  )
  const pickOne = (name: string) => {
    const rows = pool.filter((c) => c.name === name)
    if (rows.length === 0) return undefined
    rows.sort((a, b) => {
      // Prefer exact platform host over parent .xiaomimimo.com
      const aExact = a.domain === 'platform.xiaomimimo.com' ? 1 : 0
      const bExact = b.domain === 'platform.xiaomimimo.com' ? 1 : 0
      if (aExact !== bExact) return bExact - aExact
      // Then later expiry (persistent beats session / older session)
      const ae = a.expirationDate ?? Number.MAX_SAFE_INTEGER
      const be = b.expirationDate ?? Number.MAX_SAFE_INTEGER
      return be - ae
    })
    return rows[0]
  }
  const token = pickOne('api-platform_serviceToken')
  if (!token) return ''
  const uid = pickOne('userId')
  const parts = [`${token.name}=${token.value}`]
  if (uid) parts.push(`${uid.name}=${uid.value}`)
  return parts.join('; ')
}

async function clearSessionCookies(sess: Session): Promise<void> {
  const cookies = await sess.cookies.get({})
  for (const c of cookies) {
    const domain = c.domain ?? ''
    if (COOKIE_NAMES.has(c.name) && domain.includes('xiaomimimo')) {
      const host = domain.replace(/^\./, '')
      // Remove every path variant, not just the default path.
      await sess.cookies.remove(`https://${host}`, c.name)
      if (c.path && c.path !== '/') {
        await sess.cookies.remove(`https://${host}${c.path}`, c.name)
      }
    }
  }
}

/** GET the balance endpoint. status 0 = transport error. */
async function requestBalance(cookie: string): Promise<{ status: number; data?: unknown }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const resp = await fetch(BALANCE_URL, {
      headers: { Cookie: cookie, Accept: 'application/json' },
      signal: controller.signal,
    })
    if (resp.status === 401 || resp.status === 403) return { status: resp.status }
    if (!resp.ok) return { status: resp.status }
    try {
      return { status: resp.status, data: await resp.json() }
    } catch {
      return { status: resp.status }
    }
  } catch {
    return { status: 0 }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Parse the console balance response.
 *
 * Primary: money wallet `GET /api/v1/balance` (verified 2026-11-07)
 *   { code:0, data:{ balance:"21.62", giftBalance:"20.84", cashBalance:"0.78",
 *                    currency:"CNY", ... } }
 * Fallback: token-plan quota `GET /api/v1/tokenPlan/usage`
 *   { code:0, data:{ usage:{ items:[{name:'plan_total_token',used,limit}] } } }
 * (accounts on a token plan have usage populated; wallet-only accounts have
 * usage:null — that's why the old parser showed nothing.)
 */
function parseMimoBalance(data: unknown): BalanceInfo | null {
  const d = data as Record<string, any> | null
  if (!d || typeof d !== 'object') return null
  if (typeof d.code === 'number' && d.code !== 0) return null
  const body = d.data
  if (!body || typeof body !== 'object') return null

  // Cash/gift wallet — the common case. This is the CONSOLE ACCOUNT wallet
  // (one cookie = one account), not a per-sk-key ledger. Mark it so the UI
  // can label it and never pretend each key has its own balance.
  const wallet = Number(body.balance)
  if (Number.isFinite(wallet) && body.balance !== undefined && body.balance !== null) {
    const gift = Number(body.giftBalance)
    return {
      currency: typeof body.currency === 'string' && body.currency ? body.currency : 'CNY',
      available: wallet,
      total_granted: Number.isFinite(gift) ? gift : undefined,
      accountScope: true,
      accountId: typeof body.userId === 'string' ? body.userId : undefined,
      raw: d,
    }
  }

  // Token-plan quota accounts (usage populated instead of a wallet).
  const items = body.usage?.items
  if (Array.isArray(items) && items.length > 0) {
    const plan = items.find((i: any) => i && i.name === 'plan_total_token') ?? items[0]
    const limit = Number(plan?.limit) || 0
    const used = Number(plan?.used) || 0
    if (limit > 0) {
      return { currency: 'TOKEN', available: Math.max(0, limit - used), raw: d }
    }
  }
  return null
}

/**
 * Fetch balance with one account's persisted cookie.
 *
 * Returns the HTTP status too, so the caller can tell "这个会话过期了" (401/403 →
 * 删掉该账号的会话，卡片回到「连接控制台」) from "只是网络抖了一下" (status 0 →
 * 保留上一次读数，别把余额擦掉)。会话清理交给调用方按账号做。
 */
export async function fetchMimoBalance(
  cookie: string
): Promise<{ info: BalanceInfo | null; status: number }> {
  const { status, data } = await requestBalance(cookie)
  if (!data) return { info: null, status }
  const info = parseMimoBalance(data)
  if (info) {
    // Persist which account this wallet belongs to (userId from the cookie).
    const m = /(?:^|;\s*)userId=([^;]+)/.exec(cookie)
    if (m && !info.accountId) info.accountId = decodeURIComponent(m[1])
  }
  return { info, status }
}

/**
 * 获取 MiMo 控制台的累计用量（token + 金额），给「账单」页算每天用了多少。
 *
 * GET /api/v1/usage（2026-11-19 实测，需要和余额相同的控制台 cookie）
 *   { code:0, data:{
 *       tokenUsage:{ inputToken, outputToken, cacheToken, totalToken,
 *                    batchInputToken, batchOutputToken, batchCacheToken },
 *       costUsage:{ totalCost:"124.71", currentMonthCost:"27.66" } } }
 * 两个金额都是累计值（开户至今 / 自然月），所以每天的花费 = 两次累计值的差。
 * 失败一律返回 null，调用方静默处理。
 */
export async function fetchMimoUsage(cookie: string): Promise<MimoUsage | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const resp = await fetch(USAGE_URL, {
      headers: { Cookie: cookie, Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!resp.ok) return null
    const body = (await resp.json()) as {
      code?: number
      data?: { tokenUsage?: Record<string, unknown>; costUsage?: Record<string, unknown> }
    }
    if (body.code !== undefined && body.code !== 0) return null
    const tokens = body.data?.tokenUsage
    if (!tokens) return null
    const num = (v: unknown) => {
      const n = Number(v)
      return Number.isFinite(n) ? n : 0
    }
    const costUsage = body.data?.costUsage ?? {}
    return {
      totalToken: num(tokens.totalToken),
      inputToken: num(tokens.inputToken),
      outputToken: num(tokens.outputToken),
      cacheToken: num(tokens.cacheToken),
      totalCost: num(costUsage.totalCost),
      monthCost: num(costUsage.currentMonthCost),
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * console 账号名下 key 的尾 6 位列表，用于余额归属判断：
 * 只有列在这个账号里的 key 才配显示这个账号的钱包余额（否则会被误标「同账号」）。
 *
 * GET /api/v1/apiKeys（2026-11-20 实测，同一个控制台 cookie）
 *   { code:0, data:[{ id, apiKeyName, redactedApiKey, createTime,
 *                    lastUsedTime, deleted }] }
 * redactedApiKey 形如 `sk-c4rk72****…****lkv4q2`（中间打码），尾 6 位足够
 * 和配置里的 key 对上（同一控制台尾 6 位不重复）。
 * 失败一律返回 null —— 调用方退回旧行为（照旧摊派余额）。
 */
export async function fetchMimoKeyList(cookie: string): Promise<string[] | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const resp = await fetch(APIKEYS_URL, {
      headers: { Cookie: cookie, Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!resp.ok) return null
    const body = (await resp.json()) as {
      code?: number
      data?: Array<{ redactedApiKey?: string; deleted?: boolean }>
    }
    if (body.code !== undefined && body.code !== 0) return null
    if (!Array.isArray(body.data)) return null
    const out: string[] = []
    for (const item of body.data) {
      const r = item.redactedApiKey
      if (item.deleted || typeof r !== 'string' || r.length < 6) continue
      out.push(r.slice(-6))
    }
    return out
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 登录窗口专用的独立分区：每次点「连接控制台」都从干净的 cookie 环境开始。
 * 用默认分区的话，上一次登录留下的 SSO cookie 会让小米直接把你登回老账号 ——
 * 用户实测的「想连 7001 的账号，结果又给我连到 7002」就是这么来的。
 */
const LOGIN_PARTITION = 'mimo-console-login'

/** 从 cookie 里解析控制台账号 id（userId）。 */
function accountIdFromCookie(cookie: string): string {
  const m = /(?:^|;\s*)userId=([^;]+)/.exec(cookie)
  if (m) {
    try {
      return decodeURIComponent(m[1])
    } catch {
      return m[1]
    }
  }
  // 没有 userId 时用 cookie 哈希兜底，至少保证同一个账号每次都落到同一条会话。
  let hash = 0
  for (let i = 0; i < cookie.length; i++) hash = (hash * 31 + cookie.charCodeAt(i)) | 0
  return `anon-${Math.abs(hash).toString(16)}`
}

export interface MimoConnectResult {
  ok: boolean
  /** 登录成功后拿到的控制台账号 id。 */
  accountId?: string
  /** 该账号名下的密钥尾 6 位列表（接口失败时为 null）。 */
  keySuffixes?: string[] | null
  /** 用户点「连接控制台」的那把 key 是否属于这个账号；false = 登错号了。 */
  keyFound?: boolean
  error?: string
}

/** 把刚拿到的控制台 cookie 存成一条账号会话（顺便拉一次该账号的 key 尾号列表）。 */
async function persistSession(cookie: string, boundBy?: string): Promise<MimoSession> {
  const accountId = accountIdFromCookie(cookie)
  const existing = getMimoSessions().find((s) => s.accountId === accountId)
  const list = await fetchMimoKeyList(cookie)
  const keySuffixes = list && list.length > 0 ? list : (existing?.keySuffixes ?? [])
  const sess: MimoSession = {
    accountId,
    cookie,
    keySuffixes,
    updatedAt: Date.now(),
    boundBy: boundBy ?? existing?.boundBy,
  }
  saveMimoSession(sess)
  return sess
}

/**
 * Acquire a MiMo console account session — 一个账号一次登录，多个账号各自一条会话。
 *
 * 1. 点「连接控制台」的那把 key 所属账号已连过且 cookie 还有效 → 直接返回，不弹窗。
 * 2. 否则在**独立分区**里打开国内 SSO 登录页（每次都清空该分区 cookie），保证能
 *    登另一个账号，而不是被自动登回上一个账号。
 * 3. cookie 落地且余额接口返回 200 → 关闭窗口、按 userId 存会话，并告诉界面这把
 *    key 是否真属于该账号（登错号时界面提示用户）。
 * 4. 窗口提前关闭 / 5 分钟超时 → ok:false。
 */
export async function openMimoLoginWindow(
  parent: BrowserWindow | null,
  opts: { keySuffix?: string } = {}
): Promise<MimoConnectResult> {
  const { keySuffix } = opts

  // 这把 key 所属账号已经连过、会话还有效：不用再登录。
  if (keySuffix) {
    const existing = findMimoSessionBySuffix(keySuffix)
    if (existing) {
      const { status } = await requestBalance(existing.cookie)
      if (status === 200) {
        return {
          ok: true,
          accountId: existing.accountId,
          keySuffixes: existing.keySuffixes,
          keyFound: true,
        }
      }
      if (status === 401 || status === 403) removeMimoSession(existing.accountId)
    }
  }

  const loginSession = session.fromPartition(LOGIN_PARTITION)
  await clearSessionCookies(loginSession)
  const startUrl = await getSsoLoginUrl()

  return new Promise<MimoConnectResult>((resolve) => {
    let settled = false
    let pollTimer: NodeJS.Timeout | null = null
    let timeoutTimer: NodeJS.Timeout | null = null

    const win = new BrowserWindow({
      width: 1000,
      height: 700,
      parent: parent ?? undefined,
      title: '登录小米 MiMo 控制台',
      autoHideMenuBar: true,
      webPreferences: { session: loginSession },
    })

    const stopTimers = () => {
      if (pollTimer) clearInterval(pollTimer)
      if (timeoutTimer) clearTimeout(timeoutTimer)
      pollTimer = null
      timeoutTimer = null
    }

    const closeWindow = () => {
      try {
        if (!win.isDestroyed()) win.close()
      } catch {
        // window already gone
      }
    }

    /** Failure: close the window and resolve ok:false. */
    const fail = (error?: string) => {
      if (settled) return
      settled = true
      stopTimers()
      closeWindow()
      resolve({ ok: false, error })
    }

    /** Success: cookie landed → persist this account's session → close window. */
    const succeed = (cookie: string) => {
      if (settled) return
      settled = true
      stopTimers()
      closeWindow()
      void persistSession(cookie, keySuffix)
        .then((sess) => {
          const keyFound = !keySuffix ? true : sess.keySuffixes.includes(keySuffix)
          resolve({ ok: true, accountId: sess.accountId, keySuffixes: sess.keySuffixes, keyFound })
        })
        .catch((err: unknown) => resolve({ ok: false, error: String(err) }))
    }

    pollTimer = setInterval(() => {
      void (async () => {
        try {
          const cookie = await readSessionCookie(loginSession)
          if (!cookie) return
          const { status } = await requestBalance(cookie)
          if (status === 200) succeed(cookie)
          else if (status === 401 || status === 403) await clearSessionCookies(loginSession)
        } catch {
          // keep polling until timeout
        }
      })()
    }, POLL_MS)

    timeoutTimer = setTimeout(() => fail('登录超时'), LOGIN_TIMEOUT_MS)
    win.on('closed', () => fail('登录窗口已关闭'))
    void win.loadURL(startUrl)
  })
}
