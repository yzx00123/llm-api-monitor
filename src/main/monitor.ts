import { PROVIDERS, Provider } from './providers'
import { getMimoCookie, getSettings } from './store'
import { fetchMimoBalance } from './mimo'

export type MonitorStatus = 'idle' | 'checking' | 'online' | 'offline' | 'error'

export interface ProviderStatus {
  providerId: string
  /** Index of the key within that provider's key list — one box per key. */
  keyIndex: number
  /** Masked key (e.g. sk-026••••28d2) shown on the box. */
  keyMask: string
  status: MonitorStatus
  latency: number | null
  errorCode?: string
  lastChecked: number | null
  authStatus: 'unknown' | 'valid' | 'invalid'
  balanceInfo?: BalanceInfo | null
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

type StatusCallback = (statuses: Map<string, ProviderStatus>) => void

class MonitorEngine {
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

  registerProviders(list: Provider[]) {
    for (const p of list) this.registry.set(p.id, p)
  }

  unregisterProvider(id: string) {
    this.registry.delete(id)
    this.removeKeys(id)
    this.statuses.delete(id)
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

  setKeys(providerId: string, keys: string[]) {
    this.keys.set(providerId, keys)
    this.startProvider(providerId)
  }

  /** Load persisted keys without starting timers (app startup). */
  seedKeys(entries: Record<string, string[]>) {
    for (const [pid, ks] of Object.entries(entries)) {
      if (ks.length > 0) this.keys.set(pid, ks)
    }
  }

  removeKeys(providerId: string) {
    this.keys.delete(providerId)
    this.stopProvider(providerId)
  }

  setOnStatusChange(cb: StatusCallback) {
    this.onStatusChange = cb
  }

  getStatuses(): Map<string, ProviderStatus> {
    return new Map(this.statuses)
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
      this.queue.push(providerId)
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

        this.updateStatus(sk, {
          providerId,
          keyIndex,
          keyMask,
          status: 'checking',
          latency: prev?.latency ?? null,
          lastChecked: Date.now(),
          authStatus: prev?.authStatus ?? 'unknown',
          balanceInfo: prev?.balanceInfo ?? null,
        })

        // Balance refresh in parallel with the latency probe
        const balancePromise = provider.balanceUrl
          ? this.checkBalanceThrottled(provider, key, sk)
          : Promise.resolve()

        try {
          const probeStart = Date.now()
          const result = await this.testKey(provider, key)
          const latency = Date.now() - probeStart

          const before = this.statuses.get(sk)
          const outOfMoney = MonitorEngine.isOutOfMoney(result)
          if (result.success) {
            this.failCount.set(sk, 0)
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
      // Process next queued provider if any
      if (this.queue.length > 0 && this.runningCount < this.maxConcurrent) {
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

  /** 402 or "insufficient balance"-style errors mean the key has no money. */
  static isOutOfMoney(result: { status?: number; error?: string }): boolean {
    if (result.status === 402) return true
    const e = result.error ?? ''
    return /insufficient.{0,20}balance|余额不足|insufficient_quota|quota.{0,10}exceeded|credit|欠费|no.{0,10}funds/i.test(e)
  }

  private async testKey(
    provider: Provider,
    key: string,
    opts?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<{ success: boolean; authValid: boolean; error?: string; status?: number }> {
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
  ): Promise<{ success: boolean; authValid: boolean; error?: string; status?: number }> {
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
    const probeText = probe.probeText?.trim() || 'Hi'
    const probeTokens = probe.probeMaxTokens > 0 ? probe.probeMaxTokens : 16
    const probeModel = probe.probeModel?.trim() || provider.models[0] || 'gpt-4o-mini'

    try {
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
      clearTimeout(timeout)

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
        return { success: true, authValid: true, status: resp.status }
      }
      if (resp.status === 401 || resp.status === 403) {
        return { success: false, authValid: false, error: `Auth failed (${resp.status})`, status: resp.status }
      }
      return {
        success: false,
        authValid: true,
        error: `HTTP ${resp.status}: ${text.slice(0, 100)}`,
        status: resp.status,
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
  ): Promise<{ success: boolean; authValid: boolean; error?: string; status?: number }> {
    const url = `${provider.baseUrl}/v1/messages`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 10000)
    const onExternalAbort = (): void => controller.abort()
    if (opts?.signal) {
      if (opts.signal.aborted) controller.abort()
      else opts.signal.addEventListener('abort', onExternalAbort, { once: true })
    }

    const probe = getSettings()
    const probeText = probe.probeText?.trim() || 'Hi'
    const probeTokens = probe.probeMaxTokens > 0 ? probe.probeMaxTokens : 16
    const probeModel = probe.probeModel?.trim() || provider.models[0] || 'claude-haiku-4-5'

    try {
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
      clearTimeout(timeout)

      if (resp.ok) {
        return { success: true, authValid: true, status: resp.status }
      }
      if (resp.status === 401 || resp.status === 403) {
        return { success: false, authValid: false, error: `Auth failed (${resp.status})`, status: resp.status }
      }
      const text = await resp.text()
      return {
        success: false,
        authValid: true,
        error: `HTTP ${resp.status}: ${text.slice(0, 100)}`,
        status: resp.status,
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
  ): Promise<{ success: boolean; authValid: boolean; error?: string; status?: number }> {
    const probe = getSettings()
    const probeText = probe.probeText?.trim() || 'Hi'
    const probeTokens = probe.probeMaxTokens > 0 ? probe.probeMaxTokens : 16
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
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: probeText }] }],
          generationConfig: { maxOutputTokens: probeTokens },
        }),
        signal: controller.signal,
      })
      clearTimeout(timeout)

      if (resp.ok) {
        return { success: true, authValid: true, status: resp.status }
      }
      if (resp.status === 400 || resp.status === 403) {
        return { success: false, authValid: false, error: `Auth/API failed (${resp.status})`, status: resp.status }
      }
      const text = await resp.text()
      return {
        success: false,
        authValid: true,
        error: `HTTP ${resp.status}: ${text.slice(0, 100)}`,
        status: resp.status,
      }
    } catch (err) {
      clearTimeout(timeout)
      throw err
    } finally {
      clearTimeout(timeout)
      opts?.signal?.removeEventListener('abort', onExternalAbort)
    }
  }

  private async checkBalance(provider: Provider, key: string, providerId: string, statusKey: string) {
    try {
      if (!provider.balanceUrl) return

      // MiMo: balance needs the console session cookie, not the sk- key
      // (see src/main/mimo.ts). Cookie missing/expired → clear balance so the
      // UI can offer the connect button.
      if (providerId === 'mimo') {
        const cookie = getMimoCookie()
        if (!cookie) {
          this.applyBalance(statusKey, null)
          return
        }
        const info = await fetchMimoBalance(cookie)
        // null after 401 means the cookie just got cleared — drop the balance;
        // null on transient network error keeps the previous value.
        this.applyBalance(statusKey, info ?? (getMimoCookie() ? undefined : null))
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
      let resp: Response
      try {
        resp = await fetch(provider.balanceUrl, { headers, signal: controller.signal })
      } finally {
        clearTimeout(timeout)
      }
      if (!resp.ok) return

      const data = await resp.json()
      let info: BalanceInfo = { currency: 'USD', raw: data }

      if (providerId === 'deepseek') {
        // Verified 2026-10: { is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
        const b = data.balance_infos?.[0]
        info = {
          currency: b?.currency ?? 'CNY',
          available: b?.total_balance ? parseFloat(b.total_balance) : undefined,
          total_granted: b?.granted_balance ? parseFloat(b.granted_balance) : undefined,
          total_used: b?.topped_up_balance ? parseFloat(b.topped_up_balance) : undefined,
          raw: data,
        }
      } else if (providerId === 'moonshot') {
        // Verified via official docs: { code, data: { available_balance, voucher_balance, cash_balance } }, unit = 元
        const d = data.data ?? data
        info = {
          currency: 'CNY',
          available: d.available_balance ?? d.balance?.available,
          total_granted: d.voucher_balance,
          raw: data,
        }
      } else if (providerId === 'siliconflow') {
        const d = data.data ?? data
        info = {
          currency: 'CNY',
          available: d.balance ?? d.available,
          raw: data,
        }
      } else {
        // generic fallback: look for any obvious balance field
        const d = data.data ?? data
        const v = d.balance ?? d.available ?? d.available_balance ?? d.remainder
        if (v != null && !isNaN(parseFloat(v))) {
          info = { currency: data.currency ?? data.unit ?? 'CNY', available: parseFloat(v), raw: data }
        } else {
          return // can't parse — don't display partial info
        }
      }

      const status = this.statuses.get(statusKey)
      if (status) {
        status.balanceInfo = info
        this.onStatusChange?.(this.statuses)
      }
    } catch {
      // balance check failures are non-critical
    }
  }

  private updateStatus(providerId: string, status: ProviderStatus) {
    this.statuses.set(providerId, status)
    this.onStatusChange?.(this.statuses)
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

    this.updateStatus(sk, {
      providerId,
      keyIndex,
      keyMask: MonitorEngine.maskKey(key),
      status: result.ok ? 'online' : outOfMoney ? 'error' : prev?.authStatus === 'valid' && result.ok === false ? 'error' : 'error',
      latency: result.ok ? result.latencyMs : (prev?.latency ?? null),
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
    if (
      status.errorCode === '余额不足，无法调用' &&
      info.available != null &&
      info.available > 0
    ) {
      return
    }
    // Account-scoped wallets (MiMo console cookie) are shared by every key
    // under the same login. Paint the number on the lowest keyIndex only so
    // two boxes don't both claim "their" balance (and so refresh doesn't
    // flip the badge between boxes). Others get a 同账号 marker.
    if (info.accountScope && info.available != null && info.available > 0) {
      const prefix = status.providerId + '#'
      const holders = [...this.statuses.entries()].filter(
        ([k, s]) =>
          k.startsWith(prefix) &&
          s.balanceInfo?.accountScope &&
          (s.balanceInfo.available ?? 0) > 0 &&
          s.errorCode !== '余额不足，无法调用'
      )
      const holderIndex = holders.reduce(
        (min, [, s]) => Math.min(min, s.keyIndex),
        Number.MAX_SAFE_INTEGER
      )
      const isHolder = status.keyIndex <= holderIndex
      if (!isHolder) {
        if (status.errorCode !== '余额不足，无法调用') {
          status.balanceInfo = {
            currency: info.currency,
            accountScope: true,
            accountId: info.accountId,
            available: undefined,
            raw: info.raw,
          }
          this.onStatusChange?.(this.statuses)
        }
        return
      }
      // This box is (or becomes) the holder — clear 同账号 markers on siblings.
      for (const [k, s] of this.statuses) {
        if (k === statusKey || !k.startsWith(prefix)) continue
        if (s.balanceInfo?.accountScope && s.balanceInfo.available == null && s.errorCode !== '余额不足，无法调用') {
          s.balanceInfo = {
            currency: info.currency,
            accountScope: true,
            accountId: info.accountId,
            available: undefined,
            raw: info.raw,
          }
        }
      }
    }
    status.balanceInfo = info
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
