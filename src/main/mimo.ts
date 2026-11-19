import { BrowserWindow, session } from 'electron'
import { getMimoCookie, setMimoCookie } from './store'
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
const BALANCE_URL = 'https://platform.xiaomimimo.com/api/v1/balance'
const USAGE_URL = 'https://platform.xiaomimimo.com/api/v1/usage'
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
async function readSessionCookie(): Promise<string> {
  const cookies = await session.defaultSession.cookies.get({})
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

async function clearSessionCookies(): Promise<void> {
  const cookies = await session.defaultSession.cookies.get({})
  for (const c of cookies) {
    const domain = c.domain ?? ''
    if (COOKIE_NAMES.has(c.name) && domain.includes('xiaomimimo')) {
      const host = domain.replace(/^\./, '')
      // Remove every path variant, not just the default path.
      await session.defaultSession.cookies.remove(`https://${host}`, c.name)
      if (c.path && c.path !== '/') {
        await session.defaultSession.cookies.remove(`https://${host}${c.path}`, c.name)
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
 * Fetch balance with the persisted cookie. On 401/403 the cookie is expired:
 * clear it so the UI falls back to the connect button.
 */
export async function fetchMimoBalance(cookie: string): Promise<BalanceInfo | null> {
  const { status, data } = await requestBalance(cookie)
  if (status === 401 || status === 403) {
    setMimoCookie('')
    return null
  }
  if (!data) return null
  const info = parseMimoBalance(data)
  if (info) {
    // Persist which account this wallet belongs to (userId from the cookie).
    const m = /(?:^|;\s*)userId=([^;]+)/.exec(cookie)
    if (m && !info.accountId) info.accountId = decodeURIComponent(m[1])
  }
  return info
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
 * Acquire the MiMo console cookie.
 *
 * 1. Already have a valid cookie → resolve true instantly, no window.
 * 2. Otherwise open a window at the DOMESTIC Xiaomi SSO entry (fast, zh).
 * 3. When the cookie lands AND the balance API accepts it → jump the window
 *    to the console (token-plan) and keep it open; resolve true so the main
 *    window can paint the quota. User closes the console window at will.
 * 4. Window closed before login / 5 min timeout → resolve false.
 */
export async function openMimoLoginWindow(parent: BrowserWindow | null): Promise<boolean> {
  // Fast path: cookie still valid from a previous login
  const existing = await readSessionCookie()
  if (existing) {
    const { status } = await requestBalance(existing)
    if (status === 200) return true
    if (status === 401 || status === 403) await clearSessionCookies()
  }

  const startUrl = await getSsoLoginUrl()

  return new Promise((resolve) => {
    let settled = false
    let pollTimer: NodeJS.Timeout | null = null
    let timeoutTimer: NodeJS.Timeout | null = null

    const win = new BrowserWindow({
      width: 1000,
      height: 700,
      parent: parent ?? undefined,
      title: '登录小米 MiMo 控制台',
      autoHideMenuBar: true,
    })

    const stopTimers = () => {
      if (pollTimer) clearInterval(pollTimer)
      if (timeoutTimer) clearTimeout(timeoutTimer)
      pollTimer = null
      timeoutTimer = null
    }

    /** Failure: close the window and resolve false. */
    const fail = () => {
      if (settled) return
      settled = true
      stopTimers()
      try {
        if (!win.isDestroyed()) win.close()
      } catch {
        // window already gone
      }
      resolve(false)
    }

    /** Success: close the login window immediately — cookie is already saved. */
    const succeed = () => {
      if (settled) return
      settled = true
      stopTimers()
      try {
        if (!win.isDestroyed()) win.close()
      } catch {
        // window already gone
      }
      resolve(true)
    }

    pollTimer = setInterval(() => {
      void (async () => {
        try {
          const cookie = await readSessionCookie()
          if (!cookie) return
          const { status } = await requestBalance(cookie)
          if (status === 200) {
            setMimoCookie(cookie)
            succeed()
          } else if (status === 401 || status === 403) {
            // Expired cookies still in the jar — drop them and wait for re-login.
            await clearSessionCookies()
          }
        } catch {
          // keep polling until timeout
        }
      })()
    }, POLL_MS)

    timeoutTimer = setTimeout(fail, LOGIN_TIMEOUT_MS)
    win.on('closed', () => fail())
    void win.loadURL(startUrl)
  })
}
