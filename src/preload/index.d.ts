export interface ElectronAPI {
  getProviders: () => Promise<Provider[]>
  getKeys: () => Promise<Record<string, string[]>>
  setKeys: (keys: Record<string, string[]>) => Promise<boolean>
  addApiKey: (providerId: string, keys: string[]) => Promise<boolean>
  removeApiKey: (providerId: string, keyIndex: number) => Promise<boolean>
  getCustomProviders: () => Promise<CustomProvider[]>
  addCustomProvider: (provider: any) => Promise<CustomProvider>
  updateCustomProvider: (id: string, updates: any) => Promise<CustomProvider>
  deleteCustomProvider: (id: string) => Promise<boolean>
  getSettings: () => Promise<{ intervalMs: number; enabled: boolean }>
  updateSettings: (updates: any) => Promise<boolean>
  getStatuses: () => Promise<Record<string, ProviderStatus>>
  setInterval: (intervalMs: number) => Promise<boolean>
  startMonitoring: (providerIds: string[], intervalMs: number) => Promise<boolean>
  stopMonitoring: () => Promise<boolean>
  checkNow: (providerId: string) => Promise<boolean>
  importCustom: (entries: Array<{ baseUrl: string; key: string }>) => Promise<Array<{ baseUrl: string; key: string; providerId: string }>>
  detectKey: (key: string) => Promise<string | null>
  onStatusUpdate: (callback: (statuses: Record<string, ProviderStatus>) => void) => () => void
}

export interface Provider {
  id: string
  name: string
  company: string
  baseUrl: string
  balanceUrl?: string
  models: string[]
  protocol: string
  category: string
}

export interface CustomProvider extends Provider {
  createdAt: number
  updatedAt: number
}

export interface ProviderStatus {
  providerId: string
  status: 'idle' | 'checking' | 'online' | 'offline' | 'error'
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

export interface Window {
  electronAPI: ElectronAPI
}
