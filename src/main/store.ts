import Store from 'electron-store'

interface StoreSchema {
  apiKeys: Record<string, string[]>
  customProviders: CustomProvider[]
  settings: {
    intervalMs: number
    enabled: boolean
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
  createdAt: number
  updatedAt: number
}

const store = new Store<StoreSchema>({
  name: 'llm-monitor-config',
  defaults: {
    apiKeys: {},
    customProviders: [],
    settings: {
      intervalMs: 10000,
      enabled: false,
    },
  },
})

export function getApiKeys(): Record<string, string[]> {
  return store.get('apiKeys', {})
}

export function setApiKeys(keys: Record<string, string[]>): void {
  store.set('apiKeys', keys)
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
  store.set('customProviders', [providers[idx]])
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

export function getSettings(): { intervalMs: number; enabled: boolean } {
  return store.get('settings', { intervalMs: 10000, enabled: false })
}

export function updateSettings(updates: Partial<{ intervalMs: number; enabled: boolean }>): void {
  const current = store.get('settings', { intervalMs: 10000, enabled: false })
  store.set('settings', { ...current, ...updates })
}
