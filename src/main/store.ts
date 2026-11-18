import Store from 'electron-store'

interface StoreSchema {
  apiKeys: Record<string, string[]>
  /** Full key -> custom display name (e.g. "公司号"). Survives reordering. */
  keyLabels: Record<string, string>
  /** MiMo console session cookie (api-platform_serviceToken=...; userId=...). */
  mimoCookie: string
  customProviders: CustomProvider[]
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

const store = new Store<StoreSchema>({
  name: 'llm-monitor-config',
  defaults: {
    apiKeys: {},
    keyLabels: {},
    mimoCookie: '',
    customProviders: [],
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
