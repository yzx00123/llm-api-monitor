import { PROVIDERS, Provider } from './providers'
import {
  findMimoSessionBySuffix,
  getMimoSessions,
  getSettings,
  removeMimoSession,
  saveMimoSession,
} from './store'
import { fetchMimoBalance, fetchMimoKeyList, fetchMimoUsage } from './mimo'

export type MonitorStatus = 'idle' | 'checking' | 'online' | 'offline' | 'error'

/** Alert kinds pushed to the desktop-notification layer (src/main/index.ts). */
export type AlertKind = 'down' | 'recovered' | 'broke' | 'refilled'

export interface StatusAlert {
  kind: AlertKind
  providerId: string
  keyIndex: number
  keyMask: string
  detail?: string
}

export interface ProviderStatus {
  providerId: string
  /** Index of the key within that provider's key list — one box per key. */
  keyIndex: number
  /** Masked key (e.g. sk-026••••28d2) shown on the box. */
  keyMask: string
  status: MonitorStatus
  latency: number | null
  /** Recent successful latencies (oldest → newest, capped at 30) for the sparkline. */
  latencyHistory?: number[]
  errorCode?: string
  lastChecked: number | null
  authStatus: 'unknown' | 'valid' | 'invalid'
  balanceInfo?: BalanceInfo | null
  /**
   * 被厂商限流（429）后最早可以再探测的时间戳。倒计时结束前这一轮直接跳过，
   * 既不给厂商添压，也避免把限流转成「掉线」的误报。
   */
  throttledUntil?: number
}

export interface BalanceInfo {
  currency: string
  total_granted?: number
  total_used?: number
  available?: number
  /** true = console ACCOUNT wallet (one login), not a per-key ledger. */
  accountScope?: boolean
  /** Console userId when known — helps spot a wrong-account cookie. */
  accountId?: string
  raw?: unknown
}

export interface MonitorConfig {
  intervalMs: number
  enabled: boolean
}

/**
 * 余额采样事件 —— 写进本地账本，用来推导每日消费（见 src/main/report.ts）。
 * 账号级钱包（MiMo 控制台）的 keyIndex 固定为 -1，避免几个密钥各记一份
 * 同一个钱包、把消费算成好几倍。
 */
export interface BalanceSampleEvent {
  providerId: string
  keyIndex: number
  currency: string
  available: number
  accountScope?: boolean
  /**
   * 账号级钱包的账号 id（MiMo 控制台 userId）。多个小米账号各自一个钱包，
   * 账单必须按账号分开累计，否则 A 账号的余额下降会被算到 B 账号头上。
   */
  accountId?: string
}

/** MiMo 控制台的累计用量采样（token / 金额都是累计值）。 */
export interface UsageSampleEvent {
  providerId: string
  totalToken: number
  inputToken: number
  outputToken: number
  cacheToken: number
  totalCost: number
  monthCost: number
}

type StatusCallback = (statuses: Map<string, ProviderStatus>) => void

/**
 * 一次探测实际消耗的 token（从响应体 usage 字段读出）。
 * 只反映本软件自己发起的探测，不是厂商账单里的总用量。
 */
export interface ProbeUsageEvent {
  providerId: string
  prompt: number
  completion: number
  total: number
}

export class MonitorEngine {
  private timers: Map<string, NodeJS.Timeout> = new Map()
  private statuses: Map<string, ProviderStatus> = new Map()
  private keys: Map<string, string[]> = new Map()
  private config: MonitorConfig = { intervalMs: 10000, enabled: false }
  private onStatusChange: StatusCallback | null = null
  private inFlight: Set<string> = new Set()
  private maxConcurrent = 5
  private queue: string[] = []
  private runningCount = 0
  private lastBalanceAt: Map<string, number> = new Map()
  /** Consecutive probe failures per provider — sticky-online needs 3 to demote. */
  private failCount: Map<string, number> = new Map()
  /** Custom providers live outside PROVIDERS; register them so checkProvider can resolve. */
  private registry: Map<string, Provider> = new Map()
  /** Latency ring buffer per statusKey (oldest → newest, cap 30) for the sparkline. */
  private history: Map<string, number[]> = new Map()
  /** Last stable (non-'checking') state per statusKey — alert diffing base. */
  private stableState: Map<string, { status: MonitorStatus; broke: boolean }> = new Map()
  private onAlert: ((alert: StatusAlert) => void) | null = null
  /** 余额 / 用量采样回调 —— 消费账单的唯一数据来源。 */
  private onBalanceSample: ((sample: BalanceSampleEvent) => void) | null = null
  private onUsageSample: ((sample: UsageSampleEvent) => void) | null = null
  /** 探测自身消耗的 token 回调 —— 通用 token 用量的唯一数据来源。 */
  private onProbeUsage: ((usage: ProbeUsageEvent) => void) | null = null
  /** MiMo 用量是账号级的，一个节流位就够（不用按密钥算）。 */
  private lastUsageAt: Map<string, number> = new Map()
  /** 没钱 key 的 10 秒余额轮询定时器（余额接口不消耗 token）。 */
  private brokePollTimer: ReturnType<typeof setInterval> | null = null
  private brokePolling = false
  private brokeConfirmAt: Map<string, number> = new Map()
  /**
   * MiMo 余额是账号级的：同一账号下多把 key 只该打一次接口，这里按 accountId
   * 缓存 60 秒（不同账号互不影响）。
   */
  private mimoAccountCache: Map<string, { at: number; info: BalanceInfo | null }> = new Map()
  /** 导入新 key 撞上在途探测时挂起的补跑标记（当前轮结束立即全量重测）。 */
  private pendingRecheck = new Set<string>()
  /** 429 限流退避：statusKey → 最早可探测时间 / 连续被限流次数。 */
  private throttle: Map<string, { until: number; strikes: number }> = new Map()
  /**
   * 已经确认「不认 stream:true」的厂商（只在探测里用）。有些兼容网关收到
   * stream 字段会直接 400，这里记住之后就走非流式，免得每轮都白打一次。
   */
  private streamUnsupported: Map<string, boolean> = new Map()

  registerProviders(list: Provider[]) {
    for (const p of list) this.registry.set(p.id, p)
  }

  unregisterProvider(id: string) {
    this.registry.delete(id)
    this.removeKeys(id)
    // statuses / history / throttle 这些表的键都是 `${providerId}#${keyIndex}`，不是
    // providerId 本身 —— 以前这里写成 this.statuses.delete(id)，一个都删不掉：删掉自定义
    // 供应商后幽灵状态还留在 Map 里（内存泄漏，也会被当成真实状态推给界面）。
    const prefix = `${id}#`
    const purge = <T>(map: Map<string, T>): void => {
      for (const sk of [...map.keys()]) if (sk.startsWith(prefix)) map.delete(sk)
    }
    purge(this.statuses)
    purge(this.history)
    purge(this.stableState)
    purge(this.brokeConfirmAt)
    purge(this.throttle)
    purge(this.lastBalanceAt)
    purge(this.failCount)
    this.onStatusChange?.(this.statuses)
  }

  private resolve(id: string): Provider | undefined {
    return PROVIDERS.find((p) => p.id === id) ?? this.registry.get(id)
  }

  setConfig(config: Partial<MonitorConfig>) {
    Object.assign(this.config, config)
    if (config.intervalMs !== undefined) {
      if (this.config.enabled) {
        this.stopAll()
        this.startAll()
      }
    }
  }

  /**
   * Sync a provider's key list. probeNew = indexes of freshly imported keys —
   * they get probed immediately (probeNow), not on the next polling round.
   * Monitoring off → probe once but never start a polling timer.
   */
  setKeys(providerId: string, keys: string[], probeNew?: number[]) {
    const prevKeys = this.keys.get(providerId) ?? []
    // 先按 key 字符串把状态搬到新索引上，再换 keys 数组：否则删掉中间一把 key 后，
    // 后面的 key 会整段错位——新 key 继承被删 key 的余额/延迟/错误码，若被删的那把
    // 正处于 429 退避（最长 15 分钟），新 key 在退避期内完全不探测却挂着「限流」。
    this.remapKeyStates(providerId, prevKeys, keys)
    this.keys.set(providerId, keys)

    // 只探「这把是新来的」。删掉一把 key 或者只是重排列表时，以前会走 startProvider
    // 或 checkProvider 把剩下的 key 全部重测一遍 —— 每次探测都要真打一次上游（花
    // token），用户对这笔账很敏感，纯删除操作不该产生任何请求。
    const added =
      probeNew && probeNew.length > 0
        ? probeNew
        : keys.map((_, i) => i).filter((i) => !prevKeys.includes(keys[i]))

    if (this.config.enabled) {
      if (!this.timers.has(providerId)) {
        // 全新 provider：立即探测一次并建立轮询。
        this.startProvider(providerId)
      } else if (added.length > 0) {
        void this.probeNow(providerId, added)
      }
      // 删除 / 重排：既有轮询照常跑，本轮不额外探测。
      return
    }

    // 监测关闭：只有「新导入」才探一次给个反馈，删 key 不花 token。
    if (added.length > 0) void this.probeNow(providerId, added)
  }

  /**
   * 按 key 字符串把「以 `${providerId}#${index}` 为键」的所有状态表重映射到新索引。
   *
   * 存在的理由：这些表原来只按索引记账，删掉中间一把 key 后后面全体前移，新 key 会
   * 继承旧 key 的在线状态、限流退避、失败计数（failCount≥3 时一次偶发失败就直接判掉线
   * 并弹通知）。现在保留「同一把 key」的状态、丢掉被删 key 的条目。
   */
  private remapKeyStates(providerId: string, prevKeys: string[], nextKeys: string[]): void {
    const prefix = `${providerId}#`
    const oldIndexOf = new Map<string, number>()
    prevKeys.forEach((k, i) => {
      if (k && !oldIndexOf.has(k)) oldIndexOf.set(k, i)
    })
    const fromTo: Array<[number, number]> = []
    nextKeys.forEach((k, to) => {
      const from = oldIndexOf.get(k)
      if (from !== undefined) fromTo.push([from, to])
    })

    const remap = <T>(map: Map<string, T>): Map<string, T> => {
      const out = new Map<string, T>()
      for (const [sk, v] of map) if (!sk.startsWith(prefix)) out.set(sk, v)
      for (const [from, to] of fromTo) {
        const v = map.get(`${prefix}${from}`)
        if (v !== undefined) out.set(`${prefix}${to}`, v)
      }
      return out
    }

    this.statuses = remap(this.statuses)
    this.history = remap(this.history)
    this.stableState = remap(this.stableState)
    this.brokeConfirmAt = remap(this.brokeConfirmAt)
    this.throttle = remap(this.throttle)
    this.lastBalanceAt = remap(this.lastBalanceAt)
    this.failCount = remap(this.failCount)
    // 状态对象里也存了一份 keyIndex，界面按它找卡片，一起改掉。
    for (const [sk, st] of this.statuses) {
      if (!sk.startsWith(prefix)) continue
      const idx = Number(sk.slice(prefix.length))
      if (st.keyIndex !== idx) this.statuses.set(sk, { ...st, keyIndex: idx })
    }
  }

  /**
   * Probe freshly imported keys right away instead of waiting for the next
   * interval. If this provider already has a probe in flight, checkProvider's
   * in-flight guard would silently drop the call — mark it instead and let
   * the finally block re-run a full round the moment the current one ends.
   */
  private async probeNow(providerId: string, keyIndexes: number[]): Promise<void> {
    if (this.inFlight.has(providerId)) {
      this.pendingRecheck.add(providerId)
      return
    }
    for (const keyIndex of keyIndexes) {
      await this.checkProvider(providerId, keyIndex)
    }
  }

  /** Load persisted keys without starting timers (app startup). */
  seedKeys(entries: Record<string, string[]>) {
    for (const [pid, ks] of Object.entries(entries)) {
      if (ks.length > 0) this.keys.set(pid, ks)
    }
  }

  removeKeys(providerId: string) {
    this.keys.delete(providerId)
    this.pendingRecheck.delete(providerId)
    this.stopProvider(providerId)
  }

  setOnStatusChange(cb: StatusCallback) {
    this.onStatusChange = cb
  }

  setOnAlert(cb: (alert: StatusAlert) => void) {
    this.onAlert = cb
  }

  /** 余额样本回调（账单用）。 */
  setOnBalanceSample(cb: (sample: BalanceSampleEvent) => void) {
    this.onBalanceSample = cb
  }

  /** MiMo 累计用量样本回调（账单 token 统计用）。 */
  setOnUsageSample(cb: (sample: UsageSampleEvent) => void) {
    this.onUsageSample = cb
  }

  /** 探测自身消耗的 token 回调（通用 token 用量统计用）。 */
  setOnProbeUsage(cb: (usage: ProbeUsageEvent) => void) {
    this.onProbeUsage = cb
  }

  /** 从探测响应里读到 usage 就上报；读不到（老网关不返回）就静默跳过。 */
  private reportProbeUsage(providerId: string, body: string, parse: (data: any) => ProbeUsageEvent | null): void {
    if (!this.onProbeUsage) return
    try {
      const evt = parse(JSON.parse(body))
      if (evt && Number.isFinite(evt.total) && evt.total > 0) {
        this.onProbeUsage({ ...evt, providerId })
      }
    } catch {
      // 响应不是 JSON 或没有 usage 字段 —— 不影响监测，也不记账
    }
  }

  /**
   * 记一条余额样本。只记「有具体金额」的读数：
   * 账号级钱包被标成「同账号」时 available 是空的，不能记；
   * 季度 token 套餐的 currency 是 'TOKEN'，那是 token 不是钱，也不进金额账本。
   */
  private recordBalanceSample(status: ProviderStatus, info: BalanceInfo): void {
    if (!this.onBalanceSample) return
    if (info.available == null || !Number.isFinite(info.available)) return
    if (info.currency === 'TOKEN') return
    this.onBalanceSample({
      providerId: status.providerId,
      keyIndex: info.accountScope ? -1 : status.keyIndex,
      currency: info.currency,
      available: info.available,
      accountScope: info.accountScope,
      accountId: info.accountId,
    })
  }

  /** MiMo 用量采样，自带 90 秒节流；失败静默（不影响监测）。 */
  private async sampleMimoUsage(cookie: string): Promise<void> {
    if (!this.onUsageSample) return
    const last = this.lastUsageAt.get('mimo') ?? 0
    if (Date.now() - last < 90_000) return
    this.lastUsageAt.set('mimo', Date.now())
    try {
      const usage = await fetchMimoUsage(cookie)
      if (!usage) return
      this.onUsageSample({ providerId: 'mimo', ...usage })
    } catch {
      // 用量采样失败不是监测错误，下一轮再试
    }
  }

  /**
   * 没钱的 key 每 10 秒轮询一次余额（余额接口不消耗 token，比等下一轮
   * 探测快得多）；余额一变有钱就立刻用一次真探测确认恢复（60 秒冷却，
   * 避免余额接口和探测结果不一致时反复打转）。
   */
  private ensureBrokePoll(): void {
    if (!this.config.enabled || this.brokePollTimer) return
    this.brokePollTimer = setInterval(() => {
      void this.pollBrokeKeys()
    }, 10_000)
  }

  private stopBrokePoll(): void {
    if (this.brokePollTimer) {
      clearInterval(this.brokePollTimer)
      this.brokePollTimer = null
    }
    // 不在这里清 brokeConfirmAt：探测窗口内状态瞬时变化时 broke 名单可能暂时为空，
    // 清掉冷却会让「余额接口显示有钱但 key 仍 429」的确认探测变成每 10 秒一次地烧
    // token。真正的停止（stopAll）才清。
  }

  private async pollBrokeKeys(): Promise<void> {
    if (this.brokePolling) return
    this.brokePolling = true
    try {
      const broke: Array<{ providerId: string; keyIndex: number; sk: string }> = []
      for (const [sk, st] of this.statuses) {
        if (st.errorCode !== '余额不足，无法调用') continue
        const idx = sk.lastIndexOf('#')
        if (idx > 0) broke.push({ providerId: sk.slice(0, idx), keyIndex: Number(sk.slice(idx + 1)), sk })
      }
      if (broke.length === 0) {
        this.stopBrokePoll()
        return
      }
      console.log(`[broke-poll] ${broke.length} key(s) broke — balance refresh every 10s (no token cost)`)
      for (const { providerId, keyIndex, sk } of broke) {
        const provider = this.resolve(providerId)
        const key = this.keys.get(providerId)?.[keyIndex]
        if (!provider || !key) continue
        // 欠费轮询要求「充值后 5~10 秒就能发现」，所以必须跳过账号级 60 秒缓存真查一次；
        // 余额接口本身免费，不消耗 token。
        await this.checkBalance(provider, key, providerId, sk, { skipCache: true })
        const st = this.statuses.get(sk)
        if (!st || st.errorCode !== '余额不足，无法调用') continue
        const money = st.balanceInfo?.available ?? 0
        const now = Date.now()
        if (money > 0 && now - (this.brokeConfirmAt.get(sk) ?? 0) > 60_000) {
          this.brokeConfirmAt.set(sk, now)
          void this.checkProvider(providerId, keyIndex)
        }
      }
    } finally {
      this.brokePolling = false
    }
  }

  getStatuses(): Map<string, ProviderStatus> {
    return new Map(this.statuses)
  }

  /** 当前是否在轮询。界面按钮、托盘菜单都以它为准，避免两边各记一份状态。 */
  isEnabled(): boolean {
    return this.config.enabled
  }

  startAll() {
    if (!this.config.enabled) return
    for (const id of this.keys.keys()) {
      this.startProvider(id)
    }
  }

  stopAll() {
    for (const [id, timer] of this.timers) {
      clearInterval(timer)
      this.timers.delete(id)
    }
    this.pendingRecheck.clear()
    // 队列里排着的 provider 也要清掉：否则 finally 里的出队逻辑会在「已停止」之后接着
    // 一轮轮真探测（花 token、可能把 key 打进 429 退避），用户点了停止却还在打上游。
    this.queue.length = 0
    // 冷却时间表只在真正停止时清空（运行中不能清：欠费轮询靠它做 60 秒确认节流）。
    this.brokeConfirmAt.clear()
    this.stopBrokePoll()
  }

  hasKeys(providerId: string): boolean {
    const keys = this.keys.get(providerId)
    return !!keys && keys.length > 0
  }

  startProvider(providerId: string) {
    if (this.timers.has(providerId)) {
      clearInterval(this.timers.get(providerId)!)
    }
    this.checkProvider(providerId)
    const timer = setInterval(() => this.checkProvider(providerId), this.config.intervalMs)
    this.timers.set(providerId, timer)
  }

  private stopProvider(providerId: string) {
    const timer = this.timers.get(providerId)
    if (timer) {
      clearInterval(timer)
      this.timers.delete(providerId)
    }
  }

  async checkProvider(providerId: string, onlyKeyIndex?: number) {
    if (this.inFlight.has(providerId)) return
    const provider = this.resolve(providerId)
    if (!provider) return

    const allKeys = this.keys.get(providerId)
    if (!allKeys || allKeys.length === 0) return
    const indices =
      onlyKeyIndex !== undefined
        ? [onlyKeyIndex].filter((i) => i >= 0 && i < allKeys.length)
        : allKeys.map((_, i) => i)
    if (indices.length === 0) return

    // Limit concurrent requests to avoid overwhelming the system
    if (this.runningCount >= this.maxConcurrent) {
      // Queue dedup: the same provider can be re-queued many times while it is
      // waiting (interval fires, manual checkNow, key edit) — one slot is enough.
      // 停止监测时不再入队：队列只服务于轮询，手动检测（检查按钮/新导入）不该被
      // 悄悄存起来在后台补跑。
      if (this.config.enabled && !this.queue.includes(providerId)) this.queue.push(providerId)
      return
    }

    this.inFlight.add(providerId)
    this.runningCount++
    try {
      // Probe keys concurrently (cap 4 per provider). Serial probing meant a
      // provider with 6 keys held the concurrency slot for 6 full timeouts.
      const CONCURRENCY = 4
      let cursor = 0
      const workers: Array<Promise<void>> = []
      const runOne = async (keyIndex: number): Promise<void> => {
        const key = allKeys[keyIndex]
        const sk = this.statusKey(providerId, keyIndex)
        const keyMask = MonitorEngine.maskKey(key)
        const prev = this.statuses.get(sk)

        // 限流冷却中：这一轮不探测（避免把 429 越打越久），只把倒计时挂到卡片上。
        const cool = this.throttle.get(sk)
        if (cool && cool.until > Date.now()) {
          if (prev && prev.throttledUntil !== cool.until) {
            this.updateStatus(sk, { ...prev, throttledUntil: cool.until })
          }
          return
        }

        this.updateStatus(sk, {
          providerId,
          keyIndex,
          keyMask,
          status: 'checking',
          latency: prev?.latency ?? null,
          lastChecked: Date.now(),
          authStatus: prev?.authStatus ?? 'unknown',
          balanceInfo: prev?.balanceInfo ?? null,
          // 保留上一条状态里的错误码与退避时间：checking 是瞬态，但 pollBrokeKeys
          // 是按 errorCode 找「没钱 key」的，整段覆盖会让它在探测窗口内从名单里消失
          // （只剩一把时 broke 变空 → stopBrokePoll），充值后反而发现不了恢复。
          errorCode: prev?.errorCode,
          throttledUntil: prev?.throttledUntil,
        })

        // Balance refresh in parallel with the latency probe
        const balancePromise = provider.balanceUrl
          ? this.checkBalanceThrottled(provider, key, sk)
          : Promise.resolve()

        try {
          // 抖动：同账号多把 key 不要在同一毫秒一起打上游（限流多半这么来的）。
          await new Promise((r) => setTimeout(r, this.jitterMs()))
          const probeStart = Date.now()
          const result = await this.testKey(provider, key)
          // 流式探测报告了「首字时间」就用它：非流式要等整段生成完才回响应头，
          // 那个数字会把「模型慢」算成「API 慢」，用户看到的 1~2 秒多来自这里。
          const latency = result.firstTokenMs ?? Date.now() - probeStart

          const before = this.statuses.get(sk)
          const outOfMoney = MonitorEngine.isOutOfMoney(result)
          // 429 不是掉线，也不是密钥失效：退避一轮再来，别弹「掉线」通知。
          if (!result.success && result.status === 429) {
            // 但有些厂商把「没钱」也回成 429（Moonshot: "suspended due to insufficient
            // balance"）。这种要走欠费逻辑：清掉退避、10 秒轮询余额；否则一把已经欠费
            // 的密钥会被当成限流无限退避，卡片上一直挂着「限流 HH:MM」。
            const zeroBalance =
              typeof before?.balanceInfo?.available === 'number' && before.balanceInfo.available <= 0
            if (result.outOfBalance || (outOfMoney && zeroBalance)) {
              this.clearThrottle(sk)
              this.updateStatus(sk, {
                providerId,
                keyIndex,
                keyMask,
                status: 'error',
                latency: before?.latency ?? null,
                latencyHistory: this.historyFor(sk),
                errorCode: '余额不足，无法调用',
                lastChecked: Date.now(),
                authStatus: before?.authStatus === 'valid' ? 'valid' : 'unknown',
                balanceInfo: {
                  currency: before?.balanceInfo?.currency ?? 'CNY',
                  available: 0,
                  accountScope: before?.balanceInfo?.accountScope,
                  accountId: before?.balanceInfo?.accountId,
                  raw: result.error,
                },
              })
              return
            }
            // 429 不该改变「稳定状态」：以前这里写 online/idle，把已通知过掉线的 key
            // 写成 idle 会触发一次假「已恢复」，真恢复时反而不报了。现在沿用上一次
            // 的稳定状态与错误码，只挂退避时间。
            const stable = this.stableState.get(sk)?.status
            const keepStatus: ProviderStatus['status'] =
              stable === 'online' || stable === 'error' || stable === 'offline' ? stable : 'idle'
            const until = this.noteThrottle(sk, result.retryAfterMs)
            this.updateStatus(sk, {
              providerId,
              keyIndex,
              keyMask,
              status: keepStatus,
              latency: before?.latency ?? null,
              latencyHistory: this.historyFor(sk),
              errorCode:
                keepStatus === 'online'
                  ? '被限流，稍后自动重试'
                  : (before?.errorCode ?? result.error),
              lastChecked: Date.now(),
              authStatus: before?.authStatus ?? 'unknown',
              balanceInfo: before?.balanceInfo ?? null,
              throttledUntil: until,
            })
            return
          }
          if (result.success) {
            this.clearThrottle(sk)
            this.failCount.set(sk, 0)
            this.pushHistory(sk, latency)
          } else {
            this.failCount.set(sk, (this.failCount.get(sk) ?? 0) + 1)
          }
          // Sticky online: once a key authenticates, keep showing 在线 and only
          // refresh latency. Demote to error only after 3 consecutive failures.
          // Out-of-money is always shown as error — it's not a transient blip.
          const failures = this.failCount.get(sk) ?? 0
          const everValid = before?.authStatus === 'valid'
          const stickyStatus: ProviderStatus['status'] = outOfMoney
            ? 'error'
            : result.success
              ? 'online'
              : everValid && failures < 3
                ? 'online'
                : 'error'
          this.updateStatus(sk, {
            providerId,
            keyIndex,
            keyMask,
            status: stickyStatus,
            latency: result.success ? latency : (before?.latency ?? null),
            latencyHistory: this.historyFor(sk),
            errorCode: outOfMoney
              ? '余额不足，无法调用'
              : stickyStatus === 'error'
                ? result.error
                : undefined,
            lastChecked: Date.now(),
            authStatus: result.success ? 'valid' : everValid && failures < 3 ? 'valid' : result.authValid ? 'valid' : 'invalid',
            // Probe detected insufficient balance — record it so the box shows 没钱
            // even for providers with no balance API (e.g. Xiaomi MiMo).
            balanceInfo: outOfMoney
              ? { currency: before?.balanceInfo?.currency ?? 'CNY', available: 0, raw: result.error }
              : before?.balanceInfo ?? null,
          })
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err)
          const before = this.statuses.get(sk)
          const everValid = before?.authStatus === 'valid'
          const failures = (this.failCount.get(sk) ?? 0) + 1
          this.failCount.set(sk, failures)
          this.updateStatus(sk, {
            providerId,
            keyIndex,
            keyMask,
            status: everValid && failures < 3 ? 'online' : 'offline',
            latency: before?.latency ?? null,
            errorCode: everValid && failures < 3 ? undefined : message,
            lastChecked: Date.now(),
            authStatus: everValid && failures < 3 ? 'valid' : 'unknown',
            balanceInfo: before?.balanceInfo ?? null,
          })
        }
        void balancePromise
      }

      for (let w = 0; w < Math.min(CONCURRENCY, indices.length); w++) {
        workers.push(
          (async () => {
            while (cursor < indices.length) {
              const idx = indices[cursor++]
              await runOne(idx)
            }
          })()
        )
      }
      await Promise.all(workers)
    } finally {
      this.inFlight.delete(providerId)
      this.runningCount--
      // 导入新 key 撞上这一轮时挂起的补跑：当前轮结束立即全量重测，
      // 不等下一个轮询间隔。
      if (this.pendingRecheck.delete(providerId)) {
        void this.checkProvider(providerId)
      }
      // Process next queued provider if any（停止监测后不再续跑）
      if (this.config.enabled && this.queue.length > 0 && this.runningCount < this.maxConcurrent) {
        const nextId = this.queue.shift()!
        this.checkProvider(nextId)
      }
    }
  }

  private statusKey(providerId: string, keyIndex: number): string {
    return `${providerId}#${keyIndex}`
  }

  static maskKey(key: string): string {
    if (key.length <= 12) return key
    return `${key.slice(0, 6)}••••${key.slice(-4)}`
  }

  /**
   * 金额字段统一归一化成数字。上游有时回字符串（`{"balance":"0.88"}`），直接塞进
   * BalanceInfo 会让 recordBalanceSample 的 Number.isFinite 判断失败、采样被静默
   * 丢弃 —— 卡片上看着有余额，账单页「今日消费」却永远是 0。顺带修掉
   * `x ? parseFloat(x) : undefined` 这种把数值 0 当空值的老写法。
   */
  static toAmount(raw: unknown): number | undefined {
    if (raw === null || raw === undefined || raw === '') return undefined
    const n = Number(raw)
    return Number.isFinite(n) ? n : undefined
  }

  /** 402 or "insufficient balance"-style errors mean the key has no money. */
  static isOutOfMoney(result: { status?: number; error?: string }): boolean {

    if (result.status === 402) return true
    const e = result.error ?? ''
    return /insufficient.{0,20}balance|余额不足|insufficient_quota|quota.{0,10}exceeded|credit|欠费|no.{0,10}funds/i.test(e)
  }

  /**
   * 有些厂商把「没钱」也回成 429（Moonshot 就是 429 + "suspended due to
   * insufficient balance"）。这个判断比 isOutOfMoney 更严格，只认「余额/欠费」
   * 字样，避免把真正的限流（如 "quota exceeded, retry later"）当成没钱。
   */
  static looksLikeOutOfBalance(text?: string): boolean {
    if (!text) return false
    return /insufficient.{0,20}(?:balance|funds?)|balance.{0,20}insufficient|余额不足|欠费|no.{0,10}funds|out of (?:balance|credit)|suspended due to|recharge (?:your|the) account/i.test(
      text
    )
  }

  /** Retry-After → 毫秒（既支持秒数，也支持 HTTP 日期格式）。 */
  static retryAfterFrom(resp: Response): number | undefined {
    const raw = resp.headers.get('retry-after')
    if (!raw) return undefined
    const secs = Number(raw)
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000)
    const at = Date.parse(raw)
    return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined
  }

  /**
   * 记一次限流并算出退避截止时间。优先用厂商给的 Retry-After，没给就指数退避
   * 60s → 2m → 4m → 8m → 15m（上限 15 分钟）；成功一次即清零。
   */
  private noteThrottle(sk: string, retryAfterMs?: number): number {
    const prev = this.throttle.get(sk)
    const strikes = (prev?.strikes ?? 0) + 1
    const fallback = Math.min(60_000 * 2 ** (strikes - 1), 15 * 60_000)
    const wait = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : fallback
    const until = Date.now() + Math.min(Math.max(wait, 5_000), 15 * 60_000)
    this.throttle.set(sk, { until, strikes })
    return until
  }

  private clearThrottle(sk: string): void {
    this.throttle.delete(sk)
  }

  /** 给每把 key 的探测加一点抖动，避免同账号多把 key 在同一毫秒排队打上游。 */
  private jitterMs(): number {
    return Math.floor(Math.random() * 400)
  }

  /**
   * 流式探测：返回「第一个数据块」的耗时，也就是用户真正感知的首字延迟。
   *
   * 为什么不用非流式：非流式请求时，很多网关要等整段回复都生成完才吐响应头
   * （实测 Moonshot kimi-k3 同一把 key：非流式 1.85~2.0s，流式首块 0.99~1.28s），
   * 于是卡片上显示的其实是「生成完整句话的时间」，看着像网络慢，其实是模型慢。
   *
   * 顺带把流里的事件收集起来解析 usage（探测自身 token 记账用）；读满 64KB 就
   * 主动 cancel，别为了一条 1 token 的回复把整段流量拖完。
   */
  private async streamProbe(
    url: string,
    headers: Record<string, string>,
    body: string,
    signal: AbortSignal,
    protocol: 'openai' | 'anthropic' | 'gemini' = 'openai'
  ): Promise<{
    ok: boolean
    status: number
    firstMs?: number
    text: string
    events: Record<string, any>[]
    retryAfterMs?: number
  }> {
    const started = Date.now()
    const resp = await fetch(url, { method: 'POST', headers, body, signal })
    const retryAfterMs =
      resp.status === 429 ? MonitorEngine.retryAfterFrom(resp) : undefined
    if (!resp.ok) {
      return { ok: false, status: resp.status, text: await resp.text(), events: [], retryAfterMs }
    }
    const contentType = resp.headers.get('content-type') ?? ''
    const reader = resp.body?.getReader()
    if (!reader || !contentType.includes('event-stream')) {
      // 少数兼容网关对 stream:true 仍回整段 JSON —— 退回「一次性读完」。
      const text = await resp.text()
      return { ok: true, status: resp.status, firstMs: Date.now() - started, text, events: [] }
    }

    const decoder = new TextDecoder()
    const events: Record<string, any>[] = []
    let text = ''
    let buffered = ''
    let firstMs: number | undefined
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (firstMs === undefined) firstMs = Date.now() - started
      const chunk = decoder.decode(value, { stream: true })
      text += chunk
      buffered += chunk
      let idx: number
      while ((idx = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, idx).trim()
        buffered = buffered.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          events.push(JSON.parse(payload) as Record<string, any>)
        } catch {
          // 半截 JSON / 厂商自定义事件，忽略
        }
      }
      // 1 token 的回复没必要把整段流拖完；拿到结束标志或读满 64KB 就收工。
      if (MonitorEngine.isStreamDone(events[events.length - 1] ?? {}, protocol) || text.length > 65536) {
        await reader.cancel().catch(() => {})
        break
      }
    }
    return { ok: true, status: resp.status, firstMs, text, events }
  }

  /**
   * 流式探测的 token 记账。网关不给 usage（流式常见）时按探测本身估算：
   * 输入是 'hi'（约 1 token），输出上限 1 token —— 误差 ±1 token，无所谓。
   */
  private reportProbeUsageStream(
    providerId: string,
    events: Record<string, any>[],
    protocol: 'openai' | 'anthropic' | 'gemini',
    probeTokens: number
  ): void {
    if (!this.onProbeUsage) return
    let prompt = 0
    let completion = 0
    for (const evt of events) {
      const usage = MonitorEngine.extractStreamUsage(evt, protocol)
      if (!usage) continue
      prompt = Number(usage.prompt_tokens ?? prompt) || prompt
      completion = Number(usage.completion_tokens ?? completion) || completion
    }
    if (!prompt && !completion) {
      prompt = 1
      completion = Math.max(probeTokens, 1)
    }
    const total = prompt + completion
    if (!Number.isFinite(total) || total <= 0) return
    this.onProbeUsage({ providerId, prompt, completion, total })
  }

  /** 探测失败的统一返回（401/403 记认证失败，其余算「服务可用但这次没成功」）。 */
  private probeFailure(
    status: number | undefined,
    text: string,
    retryAfterMs?: number
  ): {
    success: boolean
    authValid: boolean
    error: string
    status?: number
    retryAfterMs?: number
    outOfBalance?: boolean
  } {
    if (status === 401 || status === 403) {
      return { success: false, authValid: false, error: `Auth failed (${status})`, status }
    }
    return {
      success: false,
      authValid: true,
      error: `HTTP ${status}: ${text.slice(0, status === 429 ? 200 : 100)}`,
      status,
      retryAfterMs: status === 429 ? retryAfterMs : undefined,
      // 有些厂商把「没钱」也回成 429（正文往往写在后半段），判断要看完整正文。
      outOfBalance: MonitorEngine.looksLikeOutOfBalance(text),
    }
  }

  private async testKey(
    provider: Provider,
    key: string,
    opts?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<{ success: boolean; authValid: boolean; error?: string; status?: number; retryAfterMs?: number; outOfBalance?: boolean; firstTokenMs?: number }> {
    try {
      if (provider.protocol === 'anthropic') {
        return await this.testAnthropic(provider, key, opts)
      } else if (provider.protocol === 'gemini') {
        return await this.testGemini(provider, key, opts)
      } else {
        return await this.testOpenAICompatible(provider, key, opts)
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, authValid: false, error: message }
    }
  }

  private async testOpenAICompatible(
    provider: Provider,
    key: string,
    opts?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<{ success: boolean; authValid: boolean; error?: string; status?: number; retryAfterMs?: number; outOfBalance?: boolean; firstTokenMs?: number }> {
    const url = `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 10000)
    const onExternalAbort = (): void => controller.abort()
    if (opts?.signal) {
      if (opts.signal.aborted) controller.abort()
      else opts.signal.addEventListener('abort', onExternalAbort, { once: true })
    }

    // 测延迟 settings drive every latency probe — not a hardcoded 'Hi'.
    const probe = getSettings()
    // 探测只为「能通」：1 token 输入 + 1 token 输出就够。以前每轮要 ~28 token
    // （十几字的提示 + 16 token 输出），10 秒一轮 × 十几把 key 一天就是上百万
    // token；测延迟页仍保留用户自定义的长文本，两者互不影响。
    const probeText = 'hi'
    const probeTokens = 1
    const probeModel = probe.probeModel?.trim() || provider.models[0] || 'gpt-4o-mini'

    try {
      // 先用流式请求量「首字延迟」——这才是用户感知的 API 延迟；非流式要等整段
      // 生成完才回响应头，测出来的其实是模型吐完一整句话的时间。
      if (this.streamUnsupported.get(provider.id) !== true) {
        const streamed = await this.streamProbe(
          url,
          { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          JSON.stringify({
            model: probeModel,
            messages: [{ role: 'user', content: probeText }],
            max_tokens: probeTokens,
            stream: true,
          }),
          controller.signal
        )
        if (streamed.ok) {
          if (this.looksLikeHiddenAuthError(streamed.text)) {
            return {
              success: false,
              authValid: false,
              error: `Hidden auth error in 200 body: ${streamed.text.slice(0, 100)}`,
              status: streamed.status,
            }
          }
          this.reportProbeUsageStream(provider.id, streamed.events, 'openai', probeTokens)
          return {
            success: true,
            authValid: true,
            status: streamed.status,
            firstTokenMs: streamed.firstMs,
          }
        }
        if (streamed.status === 400 || streamed.status === 415 || streamed.status === 422) {
          // 只有「正文提到 stream」才认为是网关不支持流式；其它 400 是真参数错误。
          if (!/stream/i.test(streamed.text)) {
            return this.probeFailure(streamed.status, streamed.text, streamed.retryAfterMs)
          }
          this.streamUnsupported.set(provider.id, true)
        } else {
          return this.probeFailure(streamed.status, streamed.text, streamed.retryAfterMs)
        }
      }

      // —— 非流式兜底（网关不认 stream，或上面刚被判为不支持） ——
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: probeModel,
          messages: [{ role: 'user', content: probeText }],
          max_tokens: probeTokens,
          stream: false,
        }),
        signal: controller.signal,
      })

      // 注意：超时不能在读完响应头就清掉 —— 上游可能先返回 headers 再挂住 body，
      // 那样 abort 定时器已经失效，读取会退化到系统默认（数百秒），inFlight 长挂、
      // 卡片停在「检测中」。clearTimeout 统一放在 finally 里（body 读完之后）。
      const text = await resp.text()
      if (resp.ok) {
        // Some gateways return HTTP 200 with an error payload (e.g. MiniMax
        // legacy style {"base_resp":{"status_code":1004,"status_msg":"login fail"}}).
        // Treat those as auth failure instead of success.
        if (this.looksLikeHiddenAuthError(text)) {
          return {
            success: false,
            authValid: false,
            error: `Hidden auth error in 200 body: ${text.slice(0, 100)}`,
            status: resp.status,
          }
        }
        // 顺手记下这次探测烧掉的 token（通用 token 用量统计）。
        this.reportProbeUsage(provider.id, text, (data) => {
          const u = data?.usage
          if (!u) return null
          const prompt = Number(u.prompt_tokens ?? u.input_tokens) || 0
          const completion = Number(u.completion_tokens ?? u.output_tokens) || 0
          const total = Number(u.total_tokens) || prompt + completion
          return { providerId: provider.id, prompt, completion, total }
        })
        return { success: true, authValid: true, status: resp.status }
      }
      if (resp.status === 401 || resp.status === 403) {
        return { success: false, authValid: false, error: `Auth failed (${resp.status})`, status: resp.status }
      }
      return {
        success: false,
        authValid: true,
        error: `HTTP ${resp.status}: ${text.slice(0, resp.status === 429 ? 200 : 100)}`,
        status: resp.status,
        // 429 交给退避层处理：拿到 Retry-After 就按它等，没有就指数退避。
        retryAfterMs: resp.status === 429 ? MonitorEngine.retryAfterFrom(resp) : undefined,
        // 有些厂商把「没钱」也回成 429（正文往往写在后半段），判断要看完整正文而不是截断后的那份。
        outOfBalance: MonitorEngine.looksLikeOutOfBalance(text),
      }
    } catch (err) {
      clearTimeout(timeout)
      throw err
    } finally {
      clearTimeout(timeout)
      opts?.signal?.removeEventListener('abort', onExternalAbort)
    }
  }

  /** Detect auth failures smuggled inside HTTP 200 responses. */
  private looksLikeHiddenAuthError(body: string): boolean {
    const lower = body.toLowerCase()
    if (lower.includes('login fail') || lower.includes('invalid api key') || lower.includes('invalid api secret')) {
      return true
    }
    try {
      const data = JSON.parse(body) as Record<string, unknown>
      const br = data['base_resp'] as { status_code?: number; status_msg?: string } | undefined
      if (br && typeof br.status_code === 'number' && br.status_code !== 0) {
        return true
      }
      const err = data['error'] as { message?: string; type?: string; code?: string | number } | undefined
      if (err && typeof err === 'object') {
        const msg = String(err.message ?? '').toLowerCase()
        if (msg.includes('login fail') || msg.includes('invalid api key') || msg.includes('unauthorized')) {
          return true
        }
        if (String(err.code ?? '').toLowerCase().includes('invalid')) return true
      }
    } catch {
      // not JSON — string heuristics above are enough
    }
    return false
  }

  private async testAnthropic(
    provider: Provider,
    key: string,
    opts?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<{ success: boolean; authValid: boolean; error?: string; status?: number; retryAfterMs?: number; outOfBalance?: boolean; firstTokenMs?: number }> {
    const url = `${provider.baseUrl}/v1/messages`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 10000)
    const onExternalAbort = (): void => controller.abort()
    if (opts?.signal) {
      if (opts.signal.aborted) controller.abort()
      else opts.signal.addEventListener('abort', onExternalAbort, { once: true })
    }

    const probe = getSettings()
    // 探测只为「能通」：1 token 输入 + 1 token 输出就够。以前每轮要 ~28 token
    // （十几字的提示 + 16 token 输出），10 秒一轮 × 十几把 key 一天就是上百万
    // token；测延迟页仍保留用户自定义的长文本，两者互不影响。
    const probeText = 'hi'
    const probeTokens = 1
    const probeModel = probe.probeModel?.trim() || provider.models[0] || 'claude-haiku-4-5'

    try {
      // 流式优先：拿「首字延迟」（见 testOpenAICompatible 里的说明）。
      if (this.streamUnsupported.get(provider.id) !== true) {
        const streamed = await this.streamProbe(
          url,
          {
            'Content-Type': 'application/json',
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
          },
          JSON.stringify({
            model: probeModel,
            max_tokens: probeTokens,
            messages: [{ role: 'user', content: probeText }],
            stream: true,
          }),
          controller.signal
        )
        if (streamed.ok) {
          if (this.looksLikeHiddenAuthError(streamed.text)) {
            return {
              success: false,
              authValid: false,
              error: `Hidden auth error in 200 body: ${streamed.text.slice(0, 100)}`,
              status: streamed.status,
            }
          }
          this.reportProbeUsageStream(provider.id, streamed.events, 'anthropic', probeTokens)
          return {
            success: true,
            authValid: true,
            status: streamed.status,
            firstTokenMs: streamed.firstMs,
          }
        }
        if (streamed.status === 400 && /stream/i.test(streamed.text)) {
          this.streamUnsupported.set(provider.id, true)
        } else {
          return this.probeFailure(streamed.status, streamed.text, streamed.retryAfterMs)
        }
      }

      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: probeModel,
          max_tokens: probeTokens,
          messages: [{ role: 'user', content: probeText }],
        }),
        signal: controller.signal,
      })

      // 超时定时器留到 finally 再清：body 读取可能比响应头慢得多（见
      // testOpenAICompatible 注释）。
      if (resp.ok) {
        // 读 body 拿 usage（Anthropic 用 input_tokens/output_tokens）。
        const text = await resp.text()
        this.reportProbeUsage(provider.id, text, (data) => {
          const u = data?.usage
          if (!u) return null
          const prompt = Number(u.input_tokens) || 0
          const completion = Number(u.output_tokens) || 0
          return { providerId: provider.id, prompt, completion, total: prompt + completion }
        })
        return { success: true, authValid: true, status: resp.status }
      }
      if (resp.status === 401 || resp.status === 403) {
        return { success: false, authValid: false, error: `Auth failed (${resp.status})`, status: resp.status }
      }
      const text = await resp.text()
      return {
        success: false,
        authValid: true,
        error: `HTTP ${resp.status}: ${text.slice(0, resp.status === 429 ? 200 : 100)}`,
        status: resp.status,
        // 429 交给退避层处理：拿到 Retry-After 就按它等，没有就指数退避。
        retryAfterMs: resp.status === 429 ? MonitorEngine.retryAfterFrom(resp) : undefined,
        // 有些厂商把「没钱」也回成 429（正文往往写在后半段），判断要看完整正文而不是截断后的那份。
        outOfBalance: MonitorEngine.looksLikeOutOfBalance(text),
      }
    } catch (err) {
      clearTimeout(timeout)
      throw err
    } finally {
      clearTimeout(timeout)
      opts?.signal?.removeEventListener('abort', onExternalAbort)
    }
  }

  private async testGemini(
    provider: Provider,
    key: string,
    opts?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<{ success: boolean; authValid: boolean; error?: string; status?: number; retryAfterMs?: number; outOfBalance?: boolean; firstTokenMs?: number }> {
    const probe = getSettings()
    // 探测只为「能通」：1 token 输入 + 1 token 输出就够。以前每轮要 ~28 token
    // （十几字的提示 + 16 token 输出），10 秒一轮 × 十几把 key 一天就是上百万
    // token；测延迟页仍保留用户自定义的长文本，两者互不影响。
    const probeText = 'hi'
    const probeTokens = 1
    const model = probe.probeModel?.trim() || provider.models[0] || 'gemini-2.5-flash'
    const url = `${provider.baseUrl}/models/${model}:generateContent?key=${key}`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 10000)
    const onExternalAbort = (): void => controller.abort()
    if (opts?.signal) {
      if (opts.signal.aborted) controller.abort()
      else opts.signal.addEventListener('abort', onExternalAbort, { once: true })
    }

    try {
      // 流式优先：`:streamGenerateContent?alt=sse` 才测得到「首字延迟」，
      // `:generateContent` 要等整段生成完（见 testOpenAICompatible 里的说明）。
      if (this.streamUnsupported.get(provider.id) !== true && model) {
        const streamUrl = `${provider.baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`
        const streamed = await this.streamProbe(
          streamUrl,
          { 'Content-Type': 'application/json' },
          JSON.stringify({
            contents: [{ parts: [{ text: probeText }] }],
            generationConfig: { maxOutputTokens: probeTokens },
          }),
          controller.signal,
          'gemini'
        )
        if (streamed.ok) {
          if (this.looksLikeHiddenAuthError(streamed.text)) {
            return {
              success: false,
              authValid: false,
              error: `Hidden auth error in 200 body: ${streamed.text.slice(0, 100)}`,
              status: streamed.status,
            }
          }
          this.reportProbeUsageStream(provider.id, streamed.events, 'gemini', probeTokens)
          return {
            success: true,
            authValid: true,
            status: streamed.status,
            firstTokenMs: streamed.firstMs,
          }
        }
        if (streamed.status === 400 || streamed.status === 403) {
          return {
            success: false,
            authValid: false,
            error: `Auth/API failed (${streamed.status})`,
            status: streamed.status,
          }
        }
        return this.probeFailure(streamed.status, streamed.text, streamed.retryAfterMs)
      }

      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: probeText }] }],
          generationConfig: { maxOutputTokens: probeTokens },
        }),
        signal: controller.signal,
      })

      // 超时定时器留到 finally 再清（见 testOpenAICompatible 注释）。
      if (resp.ok) {
        // 读 body 拿 usage（Gemini 用 usageMetadata.promptTokenCount/...）。
        const text = await resp.text()
        this.reportProbeUsage(provider.id, text, (data) => {
          const u = data?.usageMetadata
          if (!u) return null
          const prompt = Number(u.promptTokenCount) || 0
          const completion = Number(u.candidatesTokenCount) || 0
          const total = Number(u.totalTokenCount) || prompt + completion
          return { providerId: provider.id, prompt, completion, total }
        })
        return { success: true, authValid: true, status: resp.status }
      }
      if (resp.status === 400 || resp.status === 403) {
        return { success: false, authValid: false, error: `Auth/API failed (${resp.status})`, status: resp.status }
      }
      const text = await resp.text()
      return {
        success: false,
        authValid: true,
        error: `HTTP ${resp.status}: ${text.slice(0, resp.status === 429 ? 200 : 100)}`,
        status: resp.status,
        // 429 交给退避层处理：拿到 Retry-After 就按它等，没有就指数退避。
        retryAfterMs: resp.status === 429 ? MonitorEngine.retryAfterFrom(resp) : undefined,
        // 有些厂商把「没钱」也回成 429（正文往往写在后半段），判断要看完整正文而不是截断后的那份。
        outOfBalance: MonitorEngine.looksLikeOutOfBalance(text),
      }
    } catch (err) {
      clearTimeout(timeout)
      throw err
    } finally {
      clearTimeout(timeout)
      opts?.signal?.removeEventListener('abort', onExternalAbort)
    }
  }

  private async checkBalance(
    provider: Provider,
    key: string,
    providerId: string,
    statusKey: string,
    opts: { skipCache?: boolean } = {}
  ) {
    try {
      if (!provider.balanceUrl) return

      // MiMo: balance needs the console session cookie, not the sk- key
      // (see src/main/mimo.ts). Cookie missing/expired → clear balance so the
      // UI can offer the connect button.
      // MiMo：余额属于「控制台账号」而不是 sk- 密钥。先按 key 尾号找到它所属的
      // 账号会话，再用那条会话自己的 cookie 去查 —— 不同小米账号各有各的钱包，
      // 7002 账号的钱不会再被摊到 7001 的卡片上（用户实测的串号问题）。
      if (providerId === 'mimo') {
        const suffix = key.slice(-6)
        let sess = findMimoSessionBySuffix(suffix)
        if (!sess) {
          // 老版本只存了一条全局 cookie，迁移过来的会话还不知道名下有哪些 key
          //（keySuffixes 为空）。应用里只有这一个账号时，就当它是这把 key 的账号 ——
          // 下面查到余额后会补拉 key 列表落库，之后就能精确匹配。多账号用户则要在
          // 每张卡片上各点一次「连接控制台」，这正是本次要的「按账号分离」。
          const orphans = getMimoSessions().filter((s) => s.keySuffixes.length === 0)
          if (orphans.length === 1) sess = orphans[0]
        }
        if (!sess) {
          // 已经确认没钱的 key（探测回 429 insufficient balance）：别用 null 把「没钱」
          // 擦成「连接控制台」—— 欠费的账号再登录控制台也只是看到 0，用户不用连。
          if (this.statuses.get(statusKey)?.errorCode === '余额不足，无法调用') return
          // 这把 key 还没连过控制台（或会话已失效被清掉）：清空余额，卡片挂「连接控制台」。
          this.applyBalance(statusKey, null)
          return
        }

        const cached = this.mimoAccountCache.get(sess.accountId)
        let info: BalanceInfo | null
        if (!opts.skipCache && cached && Date.now() - cached.at < 60_000) {
          info = cached.info
        } else {
          const res = await fetchMimoBalance(sess.cookie)
          if (res.status === 401 || res.status === 403) {
            // 会话过期：删掉这个账号，卡片回到「连接控制台」，别拿旧余额骗人。
            removeMimoSession(sess.accountId)
            this.mimoAccountCache.delete(sess.accountId)
            this.applyBalance(statusKey, null)
            return
          }
          if (res.status !== 200) {
            // 网络抖动 / 接口异常：保留上一次读数，不要把余额擦掉。
            this.applyBalance(statusKey, undefined)
            return
          }
          info = res.info
          this.mimoAccountCache.set(sess.accountId, { at: Date.now(), info })
          // 老版本迁移过来的会话还不知道名下有哪些 key，补拉一次尾号列表。
          if (info && sess.keySuffixes.length === 0) {
            const list = await fetchMimoKeyList(sess.cookie)
            if (list && list.length > 0) {
              saveMimoSession({ ...sess, keySuffixes: list, updatedAt: Date.now() })
            }
          }
        }

        this.applyBalance(statusKey, info)
        // 用量（token）是另一个接口，同一个 cookie 再拉一次；有余额才拉。
        if (info) void this.sampleMimoUsage(sess.cookie)
        return
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      if (provider.protocol === 'anthropic') {
        headers['x-api-key'] = key
      } else {
        headers['Authorization'] = `Bearer ${key}`
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 8000)
      let data: any
      try {
        const resp = await fetch(provider.balanceUrl, { headers, signal: controller.signal })
        // 401/403 = 密钥被吊销/禁用：余额已经没有意义，清掉别让卡片继续显示上次的
        // 正数（用户会以为还有钱）。其它非 2xx 保留旧值，等下一轮再试。
        if (resp.status === 401 || resp.status === 403) {
          this.applyBalance(statusKey, null)
          return
        }
        if (!resp.ok) return
        // 超时定时器覆盖到 body 读完（与探测器同理：只拿到响应头不算完）。
        data = await resp.json()
      } finally {
        clearTimeout(timeout)
      }

      let info: BalanceInfo = { currency: 'USD', raw: data }

      if (providerId === 'deepseek') {
        // Verified 2026-10: { is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
        const b = data.balance_infos?.[0]
        info = {
          currency: b?.currency ?? 'CNY',
          available: MonitorEngine.toAmount(b?.total_balance),
          total_granted: MonitorEngine.toAmount(b?.granted_balance),
          total_used: MonitorEngine.toAmount(b?.topped_up_balance),
          raw: data,
        }
      } else if (providerId === 'moonshot') {
        // Verified via official docs: { code, data: { available_balance, voucher_balance, cash_balance } }, unit = 元
        const d = data.data ?? data
        info = {
          currency: 'CNY',
          available: MonitorEngine.toAmount(d.available_balance ?? d.balance?.available),
          total_granted: MonitorEngine.toAmount(d.voucher_balance),
          raw: data,
        }
      } else if (providerId === 'siliconflow') {
        const d = data.data ?? data
        info = {
          currency: 'CNY',
          available: MonitorEngine.toAmount(d.balance ?? d.available),
          raw: data,
        }
      } else {
        // generic fallback: look for any obvious balance field
        const d = data.data ?? data
        const v = MonitorEngine.toAmount(
          d.balance ?? d.available ?? d.available_balance ?? d.remainder
        )
        if (v !== undefined) {
          info = { currency: data.currency ?? data.unit ?? 'CNY', available: v, raw: data }
        } else {
          return // can't parse — don't display partial info
        }
      }

      // 走统一的 applyBalance：它带「探测器已判定没钱时，不允许余额接口把 0 覆盖成
      // 有钱」的守卫。以前这里直接改 status.balanceInfo，Moonshot 这类欠费但仍能查到
      // 残留余额的账号会出现「卡片显示有余额、实际调用全 429」的矛盾状态。
      this.applyBalance(statusKey, info)
    } catch {
      // balance check failures are non-critical
    }
  }

  private updateStatus(providerId: string, status: ProviderStatus) {
    const prev = this.statuses.get(providerId)
    // Carry the latency ring through transient updates ('checking', error paths)
    // that don't rebuild the history themselves.
    if (status.latencyHistory === undefined) status.latencyHistory = prev?.latencyHistory
    this.statuses.set(providerId, status)

    // Alert diffing runs on stable states only — the transient 'checking'
    // updates between probes must never trigger down/recovered notifications.
    if (status.status !== 'checking') {
      const last = this.stableState.get(providerId)
      const broke = status.errorCode === '余额不足，无法调用'
      if (last) {
        const wasDown = last.status === 'error' || last.status === 'offline'
        const isDown = status.status === 'error' || status.status === 'offline'
        if (!last.broke && broke) this.emitAlert('broke', status)
        else if (last.broke && !broke && !isDown) this.emitAlert('refilled', status)
        else if (!wasDown && isDown && !broke) this.emitAlert('down', status, status.errorCode)
        else if (wasDown && !isDown) this.emitAlert('recovered', status)
      }
      this.stableState.set(providerId, { status: status.status, broke })
      // 没钱的 key 进入 10 秒余额轮询：余额接口免费不耗 token，充值后能尽快恢复。
      // 欠费判定优先于限流：清掉可能残留的退避窗口，卡片不再显示「限流」。
      if (broke) {
        this.ensureBrokePoll()
        this.clearThrottle(providerId)
      }
    }
    this.onStatusChange?.(this.statuses)
  }

  private emitAlert(kind: AlertKind, status: ProviderStatus, detail?: string) {
    this.onAlert?.({
      kind,
      providerId: status.providerId,
      keyIndex: status.keyIndex,
      keyMask: status.keyMask,
      detail
    })
  }

  /** Append one successful latency to the ring (cap 30). */
  private pushHistory(sk: string, ms: number) {
    const arr = this.history.get(sk) ?? []
    arr.push(ms)
    if (arr.length > 30) arr.shift()
    this.history.set(sk, arr)
  }

  /** Snapshot copy of the ring for publishing on a ProviderStatus. */
  private historyFor(sk: string): number[] | undefined {
    return this.history.get(sk)?.slice()
  }

  /**
   * Write a latency-test result back onto the dashboard box for this key.
   * The 测延迟 page measures real wall-clock latency; that number should
   * replace the card's latency so the dashboard reflects the custom probe.
   */
  recordLatencyResult(
    providerId: string,
    key: string,
    result: { ok: boolean; latencyMs: number; error?: string; status?: number; model: string }
  ): void {
    const keys = this.keys.get(providerId)
    if (!keys || keys.length === 0) return
    const keyIndex = keys.findIndex((k) => k === key)
    if (keyIndex < 0) return

    const sk = this.statusKey(providerId, keyIndex)
    const prev = this.statuses.get(sk)
    const outOfMoney = result.error ? MonitorEngine.isOutOfMoney({ status: result.status, error: result.error }) : false

    // 测延迟失败（429/超时/网络抖动）只刷新「上次检测时间」和延迟环，不改在线状态、
    // 不动失败计数：自动轮询要连续 3 次失败才降级，一句话没测通就把卡片打成「掉线」
    // 并弹通知是两套不一致的判据（还会绕过粘性在线门限）。欠费（402/insufficient）
    // 例外，走下面正常的 broke 逻辑。
    if (!result.ok && !outOfMoney) {
      this.updateStatus(sk, {
        ...(prev ?? {
          providerId,
          keyIndex,
          keyMask: MonitorEngine.maskKey(key),
          status: 'idle' as const,
          latency: null,
          lastChecked: Date.now(),
          authStatus: 'unknown' as const,
          balanceInfo: null,
        }),
        providerId,
        keyIndex,
        keyMask: MonitorEngine.maskKey(key),
        latencyHistory: this.historyFor(sk),
        errorCode: prev?.errorCode,
        lastChecked: Date.now(),
      })
      this.lastBalanceAt.delete(sk)
      return
    }

    if (result.ok && result.latencyMs >= 0) this.pushHistory(sk, result.latencyMs)
    this.updateStatus(sk, {
      providerId,
      keyIndex,
      keyMask: MonitorEngine.maskKey(key),
      status: result.ok ? 'online' : outOfMoney ? 'error' : prev?.authStatus === 'valid' && result.ok === false ? 'error' : 'error',
      latency: result.ok ? result.latencyMs : (prev?.latency ?? null),
      latencyHistory: this.historyFor(sk),
      errorCode: result.ok
        ? outOfMoney
          ? '余额不足，无法调用'
          : undefined
        : outOfMoney
          ? '余额不足，无法调用'
          : result.error,
      lastChecked: Date.now(),
      authStatus: result.ok ? 'valid' : result.status === 401 || result.status === 403 ? 'invalid' : (prev?.authStatus ?? 'unknown'),
      balanceInfo: outOfMoney
        ? { currency: prev?.balanceInfo?.currency ?? 'CNY', available: 0, raw: result.error }
        : (prev?.balanceInfo ?? null),
    })
    // Reset sticky-online failure streak so the custom test counts as a fresh signal
    if (result.ok) this.failCount.set(sk, 0)
    else this.failCount.set(sk, (this.failCount.get(sk) ?? 0) + 1)
    // Latency test just hit the API — let the next auto poll refresh balance too
    this.lastBalanceAt.delete(sk)
  }

  /**
   * Write balance onto one key's status.
   * `undefined` = keep the previous value (transient fetch error);
   * `null` = clear it (no cookie / unparseable).
   *
   * A key the probe flagged as out-of-money keeps its 没钱 badge: the console
   * wallet may show cash that isn't usable on that key's ledger (separate
   * credit), so overwriting 0 with the wallet total would flip-flop every cycle.
   */
  private applyBalance(statusKey: string, info: BalanceInfo | null | undefined): void {
    if (info === undefined) return
    const status = this.statuses.get(statusKey)
    if (!status) return
    if (info === null) {
      // null = clear (no cookie / unparseable) — don't run the guards below on it.
      status.balanceInfo = null
      this.onStatusChange?.(this.statuses)
      return
    }
    if (
      status.errorCode === '余额不足，无法调用' &&
      info.available != null &&
      info.available > 0
    ) {
      return
    }
    // 账号级钱包（MiMo 控制台）现在按账号归属：每把 key 显示的是「它自己所属
    // 账号」的钱包，所以同账号的多把 key 显示同一个数字是正常的 —— 不能再像以前
    // 那样只画在 keyIndex 最小的那个框上（那会把不同账号的钱混在一起显示）。
    status.balanceInfo = info
    this.recordBalanceSample(status, info)
    this.onStatusChange?.(this.statuses)
  }

  /** Refresh balance at most once per minute per key; never throws to the caller. */
  private async checkBalanceThrottled(provider: Provider, key: string, statusKey: string): Promise<void> {
    const last = this.lastBalanceAt.get(statusKey) ?? 0
    if (Date.now() - last < 60_000) return
    this.lastBalanceAt.set(statusKey, Date.now())
    try {
      await this.checkBalance(provider, key, provider.id, statusKey)
    } catch {
      // non-critical
    }
  }

  /** Drop the throttle for a provider and re-run its checks (e.g. right after console login). */
  async forceBalanceRefresh(providerId: string): Promise<void> {
    for (const k of [...this.lastBalanceAt.keys()]) {
      if (k.startsWith(providerId + '#')) this.lastBalanceAt.delete(k)
    }
    await this.checkProvider(providerId)
  }

  /**
   * 只刷余额、不做延迟探测 —— 连完控制台之后调用。
   * 探测要真的打一次 chat 接口（花 token），余额接口免费，所以这里只查余额。
   */
  async refreshBalances(providerId: string): Promise<void> {
    const provider = this.resolve(providerId)
    const keys = this.keys.get(providerId) ?? []
    if (!provider?.balanceUrl || keys.length === 0) return
    this.mimoAccountCache.clear()
    await Promise.all(
      keys.map(async (key, i) => {
        const sk = this.statusKey(providerId, i)
        // 还没探测过的 key 先补一条「等待」状态，否则余额没有卡片可以挂。
        if (!this.statuses.has(sk)) {
          this.updateStatus(sk, {
            providerId,
            keyIndex: i,
            keyMask: MonitorEngine.maskKey(key),
            status: 'idle',
            latency: null,
            lastChecked: 0,
            authStatus: 'unknown',
            balanceInfo: null,
          })
        }
        this.lastBalanceAt.delete(sk)
        try {
          await this.checkBalance(provider, key, providerId, sk)
        } catch {
          // 余额刷新失败不影响监测
        }
      })
    )
  }

  async detectKey(key: string): Promise<string | null> {
    const trimmed = key.trim()
    if (!trimmed) return null

    if (trimmed.startsWith('sk-ant-')) return 'anthropic'

    const candidates = [...PROVIDERS, ...this.registry.values()].filter(
      (p, i, arr) => p.protocol === 'openai' && arr.findIndex((x) => x.id === p.id) === i
    )
    // Detection uses a short timeout: we only need to know "does this key
    // work here?", not to wait out slow/blocked hosts. As soon as one
    // provider returns a definitive success we abort the rest — otherwise a
    // single valid key would wait for every 15s timeout (blocked hosts).
    const abort = new AbortController()
    const DETECT_TIMEOUT_MS = 6000

    const tasks = candidates.map(async (provider) => {
      try {
        const result = await this.testKey(provider, trimmed, {
          signal: abort.signal,
          timeoutMs: DETECT_TIMEOUT_MS,
        })
        if (result.success) {
          // Definitive hit — cancel every other in-flight probe.
          abort.abort()
          return { id: provider.id, score: 2 }
        }
        // Weak hit only when the key clearly passed auth: bad request (wrong
        // model/params) or rate-limited. Never trust other statuses — some
        // providers (e.g. 01.AI) answer invalid keys with 410/404/5xx.
        if (result.authValid && result.status !== undefined && [400, 402, 429].includes(result.status)) {
          return { id: provider.id, score: 1 }
        }
        return null
      } catch {
        return null
      }
    })

    const settled = await Promise.all(tasks)
    const hits = settled.filter((r): r is { id: string; score: number } => r !== null)
    if (hits.length === 0) return null
    hits.sort((a, b) => b.score - a.score)
    // Ambiguous weak hits: don't guess between multiple candidates
    if (hits[0].score === 1 && hits.filter((h) => h.score === 1).length > 1) return null
    return hits[0].id
  }

  /**
   * Fetch the full model catalog from a provider using an API key.
   * GET {baseUrl}/models — OpenAI-compatible; Anthropic uses /v1/models.
   */
  async listModels(providerId: string, key: string): Promise<{ ok: boolean; models: string[]; error?: string }> {
    const provider = this.resolve(providerId)
    if (!provider) return { ok: false, models: [], error: '供应商不存在' }
    const apiKey = key.trim()
    if (!apiKey) return { ok: false, models: [], error: '缺少 API Key' }

    let url = provider.baseUrl.replace(/\/$/, '')
    if (provider.protocol === 'anthropic') {
      if (!url.endsWith('/v1')) url += '/v1'
      url += '/models'
    } else if (provider.protocol === 'gemini') {
      // Gemini: GET /v1beta/models?key=...
      if (!/\/v1beta$/.test(url)) url += '/v1beta'
      url += `/models?key=${encodeURIComponent(apiKey)}`
    } else {
      if (!url.endsWith('/v1') && !url.endsWith('/api/v1') && !url.endsWith('/paas/v4')) {
        // most OpenAI-compatible bases already include /v1 or equivalent
      }
      url += '/models'
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12_000)
    try {
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (provider.protocol === 'anthropic') {
        headers['x-api-key'] = apiKey
        headers['anthropic-version'] = '2023-06-01'
      } else if (provider.protocol !== 'gemini') {
        headers['Authorization'] = `Bearer ${apiKey}`
      }

      const resp = await fetch(url, { headers, signal: controller.signal })
      const raw = await resp.text()
      let data: any = null
      try {
        data = JSON.parse(raw)
      } catch {
        /* not JSON */
      }

      if (!resp.ok) {
        return {
          ok: false,
          models: [],
          error: data?.error?.message ?? data?.message ?? `HTTP ${resp.status}`,
        }
      }

      // Normalize across shapes:
      // OpenAI: { data: [{ id: "..." }] }
      // Gemini: { models: [{ name: "models/gemini-2.5-flash", ... }] }
      // Anthropic: { data: [{ id: "claude-..." }], has_more }
      let ids: string[] = []
      const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : []
      for (const item of list) {
        if (!item) continue
        let id = ''
        if (typeof item === 'string') id = item
        else if (typeof item.id === 'string') id = item.id
        else if (typeof item.name === 'string') id = item.name
        // Gemini returns "models/xxx" — strip the prefix for the API call
        id = id.replace(/^models\//, '')
        if (id) ids.push(id)
      }

      // Fallback: some gateways return { models: ["a","b"] } as plain strings
      if (ids.length === 0 && Array.isArray(data?.models)) {
        ids = data.models.map((m: any) => (typeof m === 'string' ? m : m?.id ?? m?.name ?? '')).filter(Boolean)
      }

      ids = [...new Set(ids)].sort((a, b) => a.localeCompare(b))
      return { ok: true, models: ids }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, models: [], error: /abort/i.test(message) ? '请求超时（20s）' : message }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Send a custom prompt to one provider+key+model and measure wall-clock
   * latency until the full response body is received (non-stream).
   */
  async latencyTest(opts: {
    providerId: string
    key: string
    model?: string
    text?: string
    maxTokens?: number
    timeoutMs?: number
  }): Promise<{
    ok: boolean
    latencyMs: number
    status?: number
    text?: string
    error?: string
    model: string
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  }> {
    const provider = this.resolve(opts.providerId)
    if (!provider) {
      return { ok: false, latencyMs: 0, error: '供应商不存在', model: opts.model ?? '' }
    }
    const key = opts.key.trim()
    if (!key) return { ok: false, latencyMs: 0, error: '缺少 API Key', model: opts.model ?? '' }

    // Fall back to the saved 测延迟 settings when fields are omitted.
    const saved = getSettings()
    const model = (opts.model ?? '').trim() || saved.probeModel?.trim() || provider.models[0] || ''
    if (!model) return { ok: false, latencyMs: 0, error: '缺少模型名', model }
    const text = (opts.text ?? '').trim() || saved.probeText?.trim() || 'Hi'
    const maxTokens =
      opts.maxTokens && opts.maxTokens > 0 ? opts.maxTokens : saved.probeMaxTokens > 0 ? saved.probeMaxTokens : 16
    // 测延迟 measures time-to-first-token and cancels — a long timeout only
    // matters when the network is dead. 20s is plenty for a first byte.
    const timeoutMs = opts.timeoutMs ?? 20_000

    const start = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      let url = ''
      let headers: Record<string, string> = { 'Content-Type': 'application/json' }
      let body: string
      // Stream so we can stop at the first token instead of waiting for the
      // whole completion (that was the main source of "测延迟太慢").
      if (provider.protocol === 'anthropic') {
        url = `${provider.baseUrl.replace(/\/$/, '')}/v1/messages`
        headers = {
          ...headers,
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        }
        body = JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: text }],
          stream: true,
        })
      } else if (provider.protocol === 'gemini') {
        const base = provider.baseUrl.replace(/\/$/, '')
        url = `${base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`
        body = JSON.stringify({
          contents: [{ parts: [{ text }] }],
          generationConfig: { maxOutputTokens: maxTokens },
        })
      } else {
        url = `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`
        headers = { ...headers, Authorization: `Bearer ${key}` }
        body = JSON.stringify({
          model,
          messages: [{ role: 'user', content: text }],
          max_tokens: maxTokens,
          stream: true,
        })
      }

      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      })

      // Non-OK before any stream body — parse the error immediately.
      if (!resp.ok) {
        const raw = await resp.text()
        const latencyMs = Date.now() - start
        let errMsg = raw.slice(0, 200)
        try {
          const data = JSON.parse(raw) as Record<string, any>
          errMsg = String(data?.error?.message ?? data?.message ?? errMsg)
        } catch {
          /* keep raw */
        }
        return { ok: false, latencyMs, status: resp.status, error: errMsg, model }
      }

      // Read the stream until the first meaningful chunk, then cancel.
      // latencyMs = time-to-first-token (TTFT), not full generation time.
      const reader = resp.body?.getReader()
      if (!reader) {
        const raw = await resp.text()
        const latencyMs = Date.now() - start
        return { ok: true, latencyMs, status: resp.status, text: raw.slice(0, 300), model }
      }

      const decoder = new TextDecoder()
      let buf = ''
      let extracted = ''
      let ttft = 0
      const started = Date.now()

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })

        // Pull any complete lines out of the SSE buffer
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line || line.startsWith(':')) continue
          const payload = line.startsWith('data:') ? line.slice(5).trim() : line
          if (payload === '[DONE]') continue
          try {
            const evt = JSON.parse(payload) as Record<string, any>
            const piece = MonitorEngine.extractStreamText(evt, provider.protocol)
            if (piece) {
              if (!ttft) ttft = Date.now() - start
              extracted += piece
            }
            if (MonitorEngine.isStreamDone(evt, provider.protocol)) {
              reader.cancel().catch(() => {})
              const latencyMs = ttft || Date.now() - start
              return {
                ok: true,
                latencyMs,
                status: resp.status,
                text: extracted.slice(0, 500) || undefined,
                model,
                usage: MonitorEngine.extractStreamUsage(evt, provider.protocol),
              }
            }
          } catch {
            /* partial JSON — keep reading */
          }
        }

        // First token landed → we already have the number we came for.
        // Stop here so the test finishes in ~TTFT instead of full decode time.
        if (ttft) {
          reader.cancel().catch(() => {})
          return {
            ok: true,
            latencyMs: ttft,
            status: resp.status,
            text: extracted.slice(0, 500) || undefined,
            model,
          }
        }
      }

      const latencyMs = ttft || Date.now() - start
      void started
      return {
        ok: true,
        latencyMs,
        status: resp.status,
        text: extracted.slice(0, 500) || undefined,
        model,
      }
    } catch (err) {
      const latencyMs = Date.now() - start
      const message = err instanceof Error ? err.message : String(err)
      const aborted = message.includes('abort') || message.includes('AbortError')
      return {
        ok: false,
        latencyMs,
        error: aborted ? `超时（${Math.round(timeoutMs / 1000)}s）` : message,
        model,
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Pull any text delta out of a stream event for each protocol. */
  private static extractStreamText(evt: Record<string, any>, protocol: string): string {
    if (protocol === 'anthropic') {
      if (evt.type === 'content_block_delta') return evt.delta?.text ?? ''
      return ''
    }
    if (protocol === 'gemini') {
      const cand = evt.candidates?.[0]
      return (cand?.content?.parts ?? []).map((p: any) => p?.text ?? '').join('')
    }
    // OpenAI-compatible SSE
    return evt.choices?.[0]?.delta?.content ?? ''
  }

  private static isStreamDone(evt: Record<string, any>, protocol: string): boolean {
    if (protocol === 'anthropic') return evt.type === 'message_stop'
    if (protocol === 'gemini') return !!evt.candidates?.[0]?.finishReason
    const c = evt.choices?.[0]
    return c?.finish_reason != null && c.finish_reason !== ''
  }

  private static extractStreamUsage(
    evt: Record<string, any>,
    protocol: string
  ): { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined {
    if (protocol === 'anthropic' && evt.usage) {
      return {
        prompt_tokens: evt.usage.input_tokens,
        completion_tokens: evt.usage.output_tokens,
        total_tokens: (evt.usage.input_tokens ?? 0) + (evt.usage.output_tokens ?? 0),
      }
    }
    if (protocol === 'gemini' && evt.usageMetadata) {
      return {
        prompt_tokens: evt.usageMetadata.promptTokenCount,
        completion_tokens: evt.usageMetadata.candidatesTokenCount,
        total_tokens: evt.usageMetadata.totalTokenCount,
      }
    }
    if (evt.usage) return evt.usage
    return undefined
  }
}

export const monitorEngine = new MonitorEngine()
