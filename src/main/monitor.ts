import { PROVIDERS, Provider } from './providers'

export type MonitorStatus = 'idle' | 'checking' | 'online' | 'offline' | 'error'

export interface ProviderStatus {
  providerId: string
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
    for (const p of PROVIDERS) {
      if (this.keys.has(p.id)) {
        this.startProvider(p.id)
      }
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

  async checkProvider(providerId: string) {
    if (this.inFlight.has(providerId)) return
    const provider = PROVIDERS.find((p) => p.id === providerId)
    if (!provider) return

    const keys = this.keys.get(providerId)
    if (!keys || keys.length === 0) return

    // Limit concurrent requests to avoid overwhelming the system
    if (this.runningCount >= this.maxConcurrent) {
      this.queue.push(providerId)
      return
    }

    this.inFlight.add(providerId)
    this.runningCount++
    this.updateStatus(providerId, {
      providerId,
      status: 'checking',
      latency: this.statuses.get(providerId)?.latency ?? null,
      lastChecked: Date.now(),
      authStatus: this.statuses.get(providerId)?.authStatus ?? 'unknown',
    })

    const startTime = Date.now()
    try {
      for (const key of keys) {
        const result = await this.testKey(provider, key)
        const latency = Date.now() - startTime
        this.updateStatus(providerId, {
          providerId,
          status: result.success ? 'online' : 'error',
          latency,
          errorCode: result.error,
          lastChecked: Date.now(),
          authStatus: result.authValid ? 'valid' : 'invalid',
        })
        if (result.authValid && provider.balanceUrl) {
          await this.checkBalance(provider, key, providerId)
        }
        break
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      this.updateStatus(providerId, {
        providerId,
        status: 'offline',
        latency: null,
        errorCode: message,
        lastChecked: Date.now(),
        authStatus: 'unknown',
      })
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

  private async testKey(
    provider: Provider,
    key: string
  ): Promise<{ success: boolean; authValid: boolean; error?: string }> {
    try {
      if (provider.protocol === 'anthropic') {
        return await this.testAnthropic(provider, key)
      } else if (provider.protocol === 'gemini') {
        return await this.testGemini(provider, key)
      } else {
        return await this.testOpenAICompatible(provider, key)
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, authValid: false, error: message }
    }
  }

  private async testOpenAICompatible(
    provider: Provider,
    key: string
  ): Promise<{ success: boolean; authValid: boolean; error?: string }> {
    const url = `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: provider.models[0] || 'gpt-3.5-turbo',
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 5,
          stream: false,
        }),
        signal: controller.signal,
      })
      clearTimeout(timeout)

      if (resp.ok) {
        return { success: true, authValid: true }
      }
      if (resp.status === 401 || resp.status === 403) {
        return { success: false, authValid: false, error: `Auth failed (${resp.status})` }
      }
      const text = await resp.text()
      return { success: false, authValid: true, error: `HTTP ${resp.status}: ${text.slice(0, 100)}` }
    } catch (err) {
      clearTimeout(timeout)
      throw err
    }
  }

  private async testAnthropic(
    provider: Provider,
    key: string
  ): Promise<{ success: boolean; authValid: boolean; error?: string }> {
    const url = `${provider.baseUrl}/v1/messages`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: provider.models[0] || 'claude-sonnet-4-20250514',
          max_tokens: 5,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
        signal: controller.signal,
      })
      clearTimeout(timeout)

      if (resp.ok) {
        return { success: true, authValid: true }
      }
      if (resp.status === 401 || resp.status === 403) {
        return { success: false, authValid: false, error: `Auth failed (${resp.status})` }
      }
      const text = await resp.text()
      return { success: false, authValid: true, error: `HTTP ${resp.status}: ${text.slice(0, 100)}` }
    } catch (err) {
      clearTimeout(timeout)
      throw err
    }
  }

  private async testGemini(
    provider: Provider,
    key: string
  ): Promise<{ success: boolean; authValid: boolean; error?: string }> {
    const model = provider.models[0] || 'gemini-2.0-flash'
    const url = `${provider.baseUrl}/models/${model}:generateContent?key=${key}`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'Hi' }] }],
          generationConfig: { maxOutputTokens: 5 },
        }),
        signal: controller.signal,
      })
      clearTimeout(timeout)

      if (resp.ok) {
        return { success: true, authValid: true }
      }
      if (resp.status === 400 || resp.status === 403) {
        return { success: false, authValid: false, error: `Auth/API failed (${resp.status})` }
      }
      const text = await resp.text()
      return { success: false, authValid: true, error: `HTTP ${resp.status}: ${text.slice(0, 100)}` }
    } catch (err) {
      clearTimeout(timeout)
      throw err
    }
  }

  private async checkBalance(provider: Provider, key: string, providerId: string) {
    try {
      if (!provider.balanceUrl) return

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      if (provider.protocol === 'anthropic') {
        headers['x-api-key'] = key
      } else {
        headers['Authorization'] = `Bearer ${key}`
      }

      const resp = await fetch(provider.balanceUrl, { headers })
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

      const status = this.statuses.get(providerId)
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

  async detectKey(key: string): Promise<string | null> {
    const trimmed = key.trim()
    if (!trimmed) return null

    if (trimmed.startsWith('sk-ant-')) return 'anthropic'

    const candidates = PROVIDERS.filter((p) => p.protocol === 'openai')
    const tasks = candidates.map(async (provider) => {
      try {
        const result = await this.testKey(provider, trimmed)
        if (result.success) return { id: provider.id, score: 2 }
        if (result.authValid && !result.error?.includes('Auth')) return { id: provider.id, score: 1 }
        return null
      } catch {
        return null
      }
    })

    const settled = await Promise.all(tasks)
    const hits = settled.filter((r): r is { id: string; score: number } => r !== null)
    if (hits.length === 0) return null
    hits.sort((a, b) => b.score - a.score)
    return hits[0].id
  }
}

export const monitorEngine = new MonitorEngine()
