import { BrowserWindow, session } from 'electron'

/**
 * 阿里云百炼「免费额度」查询。
 *
 * 为什么不用 API Key：百炼的免费额度是**按模型**发放的（每个模型 100 万 Token、
 * 90 天有效），官方只开放了控制台页面，没有「按模型查剩余额度」的 OpenAPI
 * （`/api/v1/quotas` 之类的接口对普通 DashScope key 一律 404/401）。
 * 控制台的免费额度页走的是内部网关：
 *
 *   POST https://bailian-cs.console.aliyun.com/data/api.json
 *        ?action=BroadScopeAspnGateway&product=sfm_bailian
 *        &api=zeldaEasy.bailian-commerce.freeTrial.queryFreeTierQuotaAsyn
 *   body: params={"Api":…,"V":"1.0","Data":{"queryFreeTierQuotaRequest":{…}}}&region=cn-beijing
 *
 * 这个接口是异步的：第一次调用返回 taskId，之后带 taskId 轮询，直到返回
 * `freeTierQuotas` 列表。整个调用依赖登录态 cookie，所以做法和 MiMo 控制台一样：
 * 让用户在独立窗口里登录一次（cookie 存在持久化分区里），之后按需拉额度。
 */

const LOGIN_PARTITION = 'persist:bailian-console'
const CONSOLE_ROOT = 'https://bailian.console.aliyun.com/'
const CONSOLE_HOME =
  'https://bailian.console.aliyun.com/cn-beijing/costing-balance/free-quota'
/** 测试后门：指向本地假网关，就能在没有阿里云账号的情况下验证解析与 UI。 */
const GATEWAY_URL =
  process.env.BAILIAN_GATEWAY_URL?.trim() ||
  'https://bailian-cs.console.aliyun.com/data/api.json'
const QUOTA_API = 'zeldaEasy.bailian-commerce.freeTrial.queryFreeTierQuotaAsyn'
const REGION = 'cn-beijing'

/** 控制台把免费额度按模型大类分开查，这里跟它保持一致。 */
const MODEL_TYPES = ['Text', 'Vision', 'Multimodal', 'Audio', 'Embedding'] as const
export type BailianModelType = (typeof MODEL_TYPES)[number]

export const MODEL_TYPE_LABELS: Record<BailianModelType, string> = {
  Text: '大语言模型',
  Vision: '视觉模型',
  Multimodal: '多模态模型',
  Audio: '语音模型',
  Embedding: '向量模型',
}

export interface FreeQuotaRow {
  model: string
  modelType: BailianModelType
  /** 剩余 Token（控制台里的「剩余额度」）。 */
  remaining: number
  /** 发放总量（通常是 1,000,000）。 */
  total: number
  /** 剩余百分比，控制台直接给，缺失时本地按 remaining/total 算。 */
  remainPercentage?: number
  /** 到期时间（毫秒时间戳）；undefined 表示「每月重置/长期有效」。 */
  expireAt?: number
  /** quotaStatus === 'VALID' 且还有余量。 */
  isValid: boolean
  /** 用完即停开关：开启后额度耗尽就不会继续扣费。 */
  stopOnExhaust: boolean
}

export interface FreeQuotaSummary {
  /** 还有额度的模型数。 */
  withQuota: number
  /** 使用率 50%~80% 的模型数（剩余 20%~50%）。 */
  over50: number
  /** 使用率超 80%（剩余不足 20%）的模型数。 */
  over80: number
  /** 已用尽或已过期。 */
  exhaustedOrExpired: number
  /** 所有模型总数（含没有额度的）。 */
  total: number
  /** 剩余 Token 合计。 */
  remainingTokens: number
  /** 发放 Token 合计。 */
  totalTokens: number
}

export interface FreeQuotaResult {
  ok: boolean
  loggedIn: boolean
  rows: FreeQuotaRow[]
  summary: FreeQuotaSummary
  fetchedAt: number
  error?: string
}

const EMPTY_SUMMARY: FreeQuotaSummary = {
  withQuota: 0,
  over50: 0,
  over80: 0,
  exhaustedOrExpired: 0,
  total: 0,
  remainingTokens: 0,
  totalTokens: 0,
}

const CACHE_MS = 5 * 60 * 1000
let cache: FreeQuotaResult | null = null
let inFlight: Promise<FreeQuotaResult> | null = null

/** 在任意深度找第一个满足条件的对象（网关的包装层有好几层）。 */
function findDeep(value: unknown, test: (obj: any) => boolean, depth = 0): any {
  if (!value || typeof value !== 'object' || depth > 8) return undefined
  const anyValue = value as any
  if (!Array.isArray(anyValue) && test(anyValue)) return anyValue
  for (const child of Object.values(anyValue)) {
    const hit = findDeep(child, test, depth + 1)
    if (hit) return hit
  }
  return undefined
}

function toNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const num = Number(value)
  return Number.isFinite(num) ? num : undefined
}

function consoleSession() {
  return session.fromPartition(LOGIN_PARTITION)
}

async function callGateway(data: unknown): Promise<{ json: any; text: string }> {
  const body = new URLSearchParams({
    params: JSON.stringify({ Api: QUOTA_API, V: '1.0', Data: data }),
    region: REGION,
  })
  const url = `${GATEWAY_URL}?action=BroadScopeAspnGateway&product=sfm_bailian&api=${encodeURIComponent(QUOTA_API)}&_v=`
  const resp = await consoleSession().fetch(url, {
    method: 'POST',
    // 注意：这里不能手工塞 origin / referer —— Chromium 网络栈会因为「禁止改写的请求头」
    // 直接返回 net::ERR_BLOCKED_BY_CLIENT（实测），去掉了反而正常。
    // 会话自己带着控制台的 cookie，网关只认 cookie。
    headers: {
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      accept: 'application/json, text/plain, */*',
    },
    body: body.toString(),
  })
  const text = await resp.text()
  let json: any = null
  try {
    json = JSON.parse(text)
  } catch {
    // 非 JSON（比如整页跳到了登录页）交给调用方按「未登录」处理
  }
  return { json, text }
}

function looksLikeNotLoggedIn(text: string, json: any): boolean {
  if (/ConsoleNeedLogin|NotLogin|login\.aliyun|请登录|未登录/i.test(text)) return true
  const code = json?.code ?? json?.Code ?? json?.data?.code
  if (typeof code === 'string' && /NeedLogin|NotLogin|NoLogin/i.test(code)) return true
  // 网关在「没有登录态」时不一定回 ConsoleNeedLogin，也会回 data.success=false +
  // errorCode "Bad Request"（实测：裸会话 POST 拿到的就是这一段），这里一并当未登录。
  const data = json?.data
  if (data && data.success === false && /Bad Request|NeedLogin|NotLogin/i.test(String(data.errorCode ?? ''))) {
    return true
  }
  return false
}

/**
 * 分区里有没有阿里云的登录态 cookie。
 * 未登录时网关只会回一段 Bad Request，靠它区分「没登录」和「接口出错」更可靠，
 * 也省掉 5 次白打的请求。
 */
async function hasLoginCookie(): Promise<boolean> {
  // 测试后门：把网关指到本地假服务时不再要求登录态
  if (process.env.BAILIAN_GATEWAY_URL) return true
  try {
    const cookies = await consoleSession().cookies.get({ domain: 'aliyun.com' })
    return cookies.some(
      (cookie) =>
        !!cookie.value &&
        /login_aliyunid|aliyunid_ticket|aliyunid_pk|login_ticket|_l_g_|cookie2/i.test(cookie.name)
    )
  } catch {
    return false
  }
}

/** 解析一条 freeTierQuotas 记录，字段名照控制台前端的映射（quotaTotal 等）。 */
function parseRow(raw: any, modelType: BailianModelType): FreeQuotaRow | null {
  const model = raw?.model ?? raw?.modelCode ?? raw?.modelName
  if (!model || typeof model !== 'string') return null
  const remaining = toNumber(raw.quotaTotal) ?? 0
  const total = toNumber(raw.quotaInitTotal) ?? 0
  const percent = toNumber(raw.quotaTotalPercentage)
  const validity = toNumber(raw.quotaValidityPeriod)
  const validFlag = raw.quotaStatus === undefined ? true : raw.quotaStatus === 'VALID'
  return {
    model,
    modelType,
    remaining,
    total,
    remainPercentage:
      percent !== undefined ? percent : total > 0 ? (remaining / total) * 100 : undefined,
    expireAt: validity && validity > 1e12 ? validity : undefined,
    isValid: validFlag && remaining > 0,
    stopOnExhaust: raw.freeTierOnly === true,
  }
}

/** 从响应里挑出真正的结果对象（带 freeTierQuotas 的那层）。 */
function extractQuotaPayload(json: any): any {
  return findDeep(json, (obj) => Array.isArray(obj.freeTierQuotas))
}

function extractTaskId(json: any): string | undefined {
  const obj = findDeep(json, (value) => {
    const id = value.taskId
    return typeof id === 'string' || typeof id === 'number'
  })
  const id = obj?.taskId
  return id === undefined || id === null ? undefined : String(id)
}

/** 拉某个模型大类的额度：先拿 taskId，再轮询到出结果。 */
async function queryModelType(modelType: BailianModelType): Promise<{
  rows: FreeQuotaRow[]
  overview?: any
}> {
  let taskId: string | undefined
  for (let round = 0; round < 25; round++) {
    const request = taskId
      ? { taskId, returnUnissuedModels: false }
      : { modelType, needOverviewInfo: true, needFreeTierOnlyStatus: true, returnUnissuedModels: false }
    const { json, text } = await callGateway({ queryFreeTierQuotaRequest: request })
    if (looksLikeNotLoggedIn(text, json)) {
      throw new Error('NEED_LOGIN')
    }
    const payload = extractQuotaPayload(json)
    if (payload) {
      const rows = (payload.freeTierQuotas as any[])
        .map((item) => parseRow(item, modelType))
        .filter((row): row is FreeQuotaRow => !!row)
      return { rows, overview: payload.freeTierQuotaOverview }
    }
    const nextTaskId = extractTaskId(json)
    if (!nextTaskId) {
      throw new Error(
        `额度接口返回了无法识别的数据（${modelType}）：${text.slice(0, 160) || '空响应'}`
      )
    }
    taskId = nextTaskId
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  throw new Error(`查询 ${modelType} 免费额度超时（任务一直没算完）`)
}

function summarize(rows: FreeQuotaRow[], overviews: any[]): FreeQuotaSummary {
  const overview = overviews.find((item) => item && typeof item === 'object')
  let exhaustedFromOverview: number | undefined
  let over50 = 0
  let over80 = 0
  let withQuota = 0
  let total = 0

  if (overview) {
    const above = toNumber(overview.modelsWithQuotaAbove50Percent) ?? 0
    over50 = toNumber(overview.modelsWithQuotaBetween20And50Percent) ?? 0
    over80 = toNumber(overview.modelsWithQuotaBetween0And20Percent) ?? 0
    withQuota = above + over50 + over80
    total = toNumber(overview.totalModelCount) ?? rows.length
    exhaustedFromOverview = Math.max(total - withQuota, 0)
  } else {
    for (const row of rows) {
      total += 1
      if (!row.isValid) continue
      withQuota += 1
      const percent = row.remainPercentage
      if (percent === undefined) continue
      if (percent <= 20) over80 += 1
      else if (percent <= 50) over50 += 1
    }
  }

  const exhaustedOrExpired = exhaustedFromOverview ?? Math.max(total - withQuota, 0)
  return {
    withQuota,
    over50,
    over80,
    exhaustedOrExpired,
    total,
    remainingTokens: rows.reduce((sum, row) => sum + (row.remaining > 0 ? row.remaining : 0), 0),
    totalTokens: rows.reduce((sum, row) => sum + (row.total > 0 ? row.total : 0), 0),
  }
}

async function fetchQuota(): Promise<FreeQuotaResult> {
  if (!(await hasLoginCookie())) throw new Error('NEED_LOGIN')
  const failures: string[] = []
  const results = await Promise.all(
    MODEL_TYPES.map(async (modelType) => {
      try {
        return await queryModelType(modelType)
      } catch (err) {
        if (err instanceof Error && err.message === 'NEED_LOGIN') throw err
        // 某一类查失败不该毁掉整张表（有的账号没有语音/向量模型）
        failures.push(`${modelType}: ${err instanceof Error ? err.message : String(err)}`)
        return { rows: [] as FreeQuotaRow[], overview: undefined }
      }
    })
  )
  const rows = results.flatMap((item) => item.rows)
  if (rows.length === 0 && failures.length > 0) {
    throw new Error(`免费额度接口调用失败 —— ${failures.slice(0, 2).join('；')}`)
  }
  const summary = summarize(
    rows,
    results.map((item) => item.overview)
  )
  return { ok: true, loggedIn: true, rows, summary, fetchedAt: Date.now() }
}

function emptyResult(error: string, loggedIn = false): FreeQuotaResult {
  return {
    ok: false,
    loggedIn,
    rows: [],
    summary: { ...EMPTY_SUMMARY },
    fetchedAt: Date.now(),
    error,
  }
}

/**
 * 读取免费额度。默认走 5 分钟缓存；`force` 时重新拉。
 * 没登录/登录过期时返回 `loggedIn:false`，UI 据此提示「登录百炼控制台」。
 */
export async function getFreeQuota(force = false): Promise<FreeQuotaResult> {
  if (!force && cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const result = await fetchQuota()
      cache = result
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message === 'NEED_LOGIN') {
        cache = null
        return emptyResult('还没登录阿里云百炼控制台（免费额度只能在控制台里查）')
      }
      return emptyResult(message, cache?.loggedIn ?? false)
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

/** 上次成功拉到的数据（不触发网络请求），用于 UI 首屏秒开。 */
export function peekFreeQuota(): FreeQuotaResult | null {
  return cache
}

export interface BailianLoginResult {
  ok: boolean
  rows?: FreeQuotaRow[]
  summary?: FreeQuotaSummary
  error?: string
}

/**
 * 打开百炼控制台的「免费额度」页让用户登录。
 * 登录成功后窗口不会自动关（用户可能还要点「用完即停」），但我们一旦检测到
 * 能拿到额度，就把结果返回给 UI，并保留窗口让用户自己关。
 */
export async function openBailianLogin(
  parent: BrowserWindow | null
): Promise<BailianLoginResult> {
  const browserSession = consoleSession()
  const win = new BrowserWindow({
    parent: parent ?? undefined,
    width: 1180,
    height: 820,
    title: '登录阿里云百炼控制台',
    autoHideMenuBar: true,
    webPreferences: { session: browserSession },
  })
  // 打开控制台首页而不是深链 —— 首页会自己判断登录态并跳转阿里云 SSO 登录页，
  // 深链在未登录时只会停在空白页，用户找不到登录入口。
  await win.loadURL(CONSOLE_ROOT).catch(() => undefined)

  const deadline = Date.now() + 5 * 60 * 1000
  while (Date.now() < deadline && !win.isDestroyed()) {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const result = await getFreeQuota(true)
    if (result.ok) {
      if (!win.isDestroyed()) win.close()
      return { ok: true, rows: result.rows, summary: result.summary }
    }
  }
  if (!win.isDestroyed()) win.close()
  return { ok: false, error: '登录超时（5 分钟）。请重新点「登录百炼控制台」再试一次。' }
}

/** 退出登录：清掉分区里的所有 cookie。 */
export async function logoutBailian(): Promise<void> {
  cache = null
  try {
    await consoleSession().clearStorageData()
  } catch {
    // 清不掉也不影响下次登录
  }
}
