import { BrowserWindow, session } from 'electron'
import type { Session } from 'electron'
import { createHash, createHmac } from 'crypto'

/**
 * 小米 MiMo「消费账单」历史明细。
 *
 * 控制台的账单明细接口带签名，算法是从控制台前端 bundle 里逆向出来的：
 *   msg = [METHOD, pathname, 排序后的 query, sha256(JSON body) 或空串, 秒级时间戳].join('\n')
 *   X-Sign = HmacSHA256(msg, signKey)，另有 X-Timestamp / X-Key-Epoch 两个头
 * signKey 来自 GET /api/v1/user/sign-key（有效期约 10 小时）。
 *
 * 另外接口要求 query 里带 `api-platform_ph`，这个 cookie 是控制台页面加载时服务端下发的
 * （普通接口调用不会下发），所以这里用一个独立分区灌入登录 cookie、静默加载一次控制台页面
 * 拿到新的 ph，再用该分区的 cookie 直接发签名请求。
 */

const CONSOLE_ORIGIN = process.env.MIMO_CONSOLE_ORIGIN?.trim() || 'https://platform.xiaomimimo.com'

/** 账单专用分区：和「连接控制台」登录窗口的干净分区互不影响。 */
const BILL_PARTITION = 'persist:mimo-bill'

/** signKey 缓存（接口自己会声明 expiresAt，这里再留 60 秒余量）。 */
let signCache: { key: string; epoch: number; expiresAt: number } | null = null

export interface MimoBillRow {
  /** 账期日期，YYYY-MM-DD。 */
  date: string
  model: string
  /** 密钥（控制台返回的是脱敏后的，如 sk-cdrezi****…）。 */
  apiKey: string
  currency: string
  /** 当天这个模型/密钥的花费。 */
  cost: number
  totalToken: number
  inputHitToken: number
  inputMissToken: number
  outputToken: number
  requests: number
}

export interface MimoBillMonthResult {
  year: number
  month: number
  rows: number
  cost: number
}

export interface MimoBillFetchResult {
  ok: boolean
  /** true = 控制台登录态失效，需要用户重新点「连接控制台」。 */
  needLogin?: boolean
  rows: MimoBillRow[]
  months: MimoBillMonthResult[]
  error?: string
}

const unquote = (value: string | undefined): string => (value ?? '').replace(/^"|"$/g, '').trim()

const sha256hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/**
 * 生成控制台接口的签名头。导出是为了让自检脚本能用同一份实现验证签名。
 * @param urlStr 完整 URL（query 会自己排序，和前端实现一致）
 * @param bodyStr 请求体 JSON 字符串；GET 或空 body 传空串
 */
export function signMimoConsoleRequest(
  method: string,
  urlStr: string,
  bodyStr: string,
  signKey: string,
  epoch: number,
  offsetMs = 0
): { 'X-Sign': string; 'X-Timestamp': string; 'X-Key-Epoch': string } {
  const url = new URL(urlStr, CONSOLE_ORIGIN)
  const query = (url.search.startsWith('?') ? url.search.slice(1) : url.search)
    .split('&')
    .filter(Boolean)
    .sort()
    .join('&')
  const bodyHash = bodyStr ? sha256hex(bodyStr) : ''
  const timestamp = String(Math.floor((Date.now() + offsetMs) / 1000))
  const msg = [method.toUpperCase(), url.pathname, query, bodyHash, timestamp].join('\n')
  return {
    'X-Sign': createHmac('sha256', signKey).update(msg, 'utf8').digest('hex'),
    'X-Timestamp': timestamp,
    'X-Key-Epoch': String(epoch)
  }
}

function billSession(): Session {
  return session.fromPartition(BILL_PARTITION)
}

/** 把会话里存的 cookie 字符串灌进账单分区（覆盖同名 cookie）。 */
async function primeCookies(ses: Session, cookie: string): Promise<boolean> {
  let hasToken = false
  for (const part of cookie.split(';')) {
    const trimmed = part.trim()
    const idx = trimmed.indexOf('=')
    if (idx <= 0) continue
    const name = trimmed.slice(0, idx).trim()
    const value = trimmed.slice(idx + 1).trim()
    if (!name) continue
    if (name === 'api-platform_serviceToken') hasToken = true
    try {
      await ses.cookies.set({ url: CONSOLE_ORIGIN + '/', name, value, path: '/' })
    } catch {
      // 单个 cookie 写不进去不影响整体，后面用是否拿到 ph 判断登录态
    }
  }
  return hasToken
}

/**
 * 静默加载一次控制台页面，让服务端把新的 api-platform_ph 下发到分区 cookie 里。
 * 登录态失效时会被重定向到 account.xiaomi.com，这里据此判定 needLogin。
 */
async function refreshPh(ses: Session): Promise<{ ph?: string; needLogin?: boolean }> {
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 800,
    webPreferences: { partition: BILL_PARTITION, sandbox: true }
  })
  try {
    await win.loadURL(CONSOLE_ORIGIN + '/console/usage')
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const pageUrl = win.webContents.getURL()
    const cookies = await ses.cookies.get({})
    const ph = unquote(cookies.find((c) => c.name === 'api-platform_ph')?.value)
    const token = cookies.find((c) => c.name === 'api-platform_serviceToken')
    if (!token || !ph || pageUrl.includes('account.xiaomi.com')) {
      return { needLogin: true }
    }
    return { ph }
  } finally {
    win.destroy()
  }
}

async function readSignKey(ses: Session): Promise<{ key: string; epoch: number } | { needLogin: true }> {
  if (signCache && signCache.expiresAt - Date.now() > 60_000) {
    return { key: signCache.key, epoch: signCache.epoch }
  }
  const resp = await ses.fetch(CONSOLE_ORIGIN + '/api/v1/user/sign-key', { credentials: 'include' })
  if (resp.status === 401 || resp.status === 403) return { needLogin: true }
  if (!resp.ok) throw new Error(`sign-key 接口返回 HTTP ${resp.status}`)
  const json = (await resp.json()) as { data?: { signKey?: string; epoch?: number; expiresAt?: number } } & {
    signKey?: string
    epoch?: number
    expiresAt?: number
  }
  const payload = json.data ?? json
  const key = payload.signKey
  const epoch = Number(payload.epoch)
  if (typeof key !== 'string' || !key || !Number.isFinite(epoch)) {
    throw new Error('sign-key 接口返回的内容看不懂')
  }
  const expiresAt = Number(payload.expiresAt)
  signCache = {
    key,
    epoch,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt * 1000 : Date.now() + 10 * 60 * 60 * 1000
  }
  return { key, epoch }
}

interface RawBillRow {
  date?: string
  model?: string
  apiKey?: string
  currency?: string
  consumedAmount?: string | number
  totalToken?: string | number
  inputHitToken?: string | number
  inputMissToken?: string | number
  outputToken?: string | number
  requestCount?: string | number
}

function toNumber(raw: string | number | undefined): number {
  if (raw === undefined || raw === null || raw === '') return 0
  const n = Number(raw)
  return Number.isFinite(n) ? n : 0
}

function normalizeRow(raw: RawBillRow): MimoBillRow | null {
  if (!raw.date || !raw.model) return null
  return {
    date: raw.date,
    model: raw.model,
    apiKey: raw.apiKey ?? '',
    currency: raw.currency ?? 'CNY',
    cost: toNumber(raw.consumedAmount),
    totalToken: toNumber(raw.totalToken),
    inputHitToken: toNumber(raw.inputHitToken),
    inputMissToken: toNumber(raw.inputMissToken),
    outputToken: toNumber(raw.outputToken),
    requests: toNumber(raw.requestCount)
  }
}

/**
 * 拉取最近 N 个月的小米 MiMo 消费账单明细（控制台口径：按天 × 模型 × 密钥）。
 * @param cookie 「连接控制台」时存下来的 cookie 字符串（serviceToken / userId / slh）
 * @param months 往前拉几个月，默认 12
 */
export async function fetchMimoBills(opts: { cookie: string; months?: number }): Promise<MimoBillFetchResult> {
  const empty: MimoBillFetchResult = { ok: false, rows: [], months: [] }
  const months = Math.min(Math.max(Math.floor(opts.months ?? 12), 1), 24)
  const ses = billSession()
  try {
    const hasToken = await primeCookies(ses, opts.cookie)
    if (!hasToken) {
      return { ...empty, needLogin: true, error: '还没有小米控制台的登录态，请先点卡片上的「连接控制台」' }
    }
    const phResult = await refreshPh(ses)
    if (!phResult.ph) {
      return {
        ...empty,
        needLogin: true,
        error: '小米控制台登录已过期，请点卡片上的「连接控制台」重新登录一次'
      }
    }
    const sign = await readSignKey(ses)
    if ('needLogin' in sign) {
      return { ...empty, needLogin: true, error: '小米控制台登录已过期，请重新登录一次' }
    }

    const now = new Date()
    const rows: MimoBillRow[] = []
    const monthStats: MimoBillMonthResult[] = []
    for (let i = 0; i < months; i++) {
      const cursor = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const year = cursor.getFullYear()
      const month = cursor.getMonth() + 1
      const bodyStr = JSON.stringify({ year, month })
      const url =
        `${CONSOLE_ORIGIN}/api/v1/usage/detail/list?api-platform_ph=` + encodeURIComponent(phResult.ph)
      const headers = signMimoConsoleRequest('POST', url, bodyStr, sign.key, sign.epoch)
      const resp = await ses.fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-timeZone': 'Asia/Shanghai',
          ...headers
        },
        body: bodyStr
      })
      if (resp.status === 401 || resp.status === 403) {
        return { ...empty, needLogin: true, error: '小米控制台登录已过期，请重新登录一次' }
      }
      if (!resp.ok) {
        // 单月失败不毁整表：记 0 行继续往后拉
        monthStats.push({ year, month, rows: 0, cost: 0 })
        continue
      }
      const json = (await resp.json()) as { code?: number; data?: RawBillRow[] }
      const list = Array.isArray(json.data) ? json.data : []
      let cost = 0
      for (const item of list) {
        const row = normalizeRow(item)
        if (!row) continue
        rows.push(row)
        cost += row.cost
      }
      monthStats.push({ year, month, rows: list.length, cost: Math.round(cost * 10000) / 10000 })
    }
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    return { ok: true, rows, months: monthStats }
  } catch (err) {
    return { ...empty, error: `账单接口调用失败：${(err as Error)?.message ?? String(err)}` }
  }
}
