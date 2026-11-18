export interface ElectronAPI {
  getProviders: () => Promise<Provider[]>
  getKeys: () => Promise<Record<string, string[]>>
  getKeyLabels: () => Promise<Record<string, string>>
  setKeyLabel: (key: string, label: string) => Promise<boolean>
  setKeys: (keys: Record<string, string[]>) => Promise<boolean>
  addApiKey: (providerId: string, keys: string[]) => Promise<boolean>
  removeApiKey: (providerId: string, keyIndex: number) => Promise<boolean>
  getCustomProviders: () => Promise<CustomProvider[]>
  addCustomProvider: (provider: any) => Promise<CustomProvider>
  updateCustomProvider: (id: string, updates: any) => Promise<CustomProvider>
  deleteCustomProvider: (id: string) => Promise<boolean>
  getSettings: () => Promise<{
    intervalMs: number
    enabled: boolean
    autoStart: boolean
    onboarded: boolean
    theme: 'light' | 'dark' | 'system'
    probeText: string
    probeMaxTokens: number
    probeModel: string
    alertsEnabled: boolean
    alertSound: boolean
    alertOnRecovery: boolean
    minimizeToTray: boolean
  }>
  updateSettings: (updates: any) => Promise<boolean>
  getStatuses: () => Promise<Record<string, ProviderStatus>>
  setInterval: (intervalMs: number) => Promise<boolean>
  startMonitoring: (providerIds: string[], intervalMs: number) => Promise<boolean>
  stopMonitoring: () => Promise<boolean>
  checkNow: (providerId: string, keyIndex?: number) => Promise<boolean>
  importCustom: (entries: Array<{ baseUrl: string; key: string }>) => Promise<Array<{ baseUrl: string; key: string; providerId: string }>>
  detectKey: (key: string) => Promise<string | null>
  /** Open the MiMo console login window; resolves true when cookie saved. */
  mimoConnect: () => Promise<boolean>
  /** Send custom text+model to one provider and measure latency.
   *  Omitted fields fall back to the saved 测延迟 settings. */
  latencyTest: (opts: {
    providerId: string
    key: string
    model?: string
    text?: string
    maxTokens?: number
    timeoutMs?: number
  }) => Promise<LatencyTestResult>
  /** Fetch the provider's full model catalog via GET /models. */
  listModels: (
    providerId: string,
    key: string
  ) => Promise<{ ok: boolean; models: string[]; error?: string }>
  getVersion: () => Promise<string>
  copyText: (text: string) => Promise<boolean>
  saveTextFile: (opts: { defaultName: string; content: string }) => Promise<{ ok: boolean; path?: string }>
  /** Save a CSV snapshot of all key statuses (Excel-friendly, BOM). */
  exportStatusCsv: () => Promise<{ ok: boolean; path?: string }>
  detectAgentConfigs: () => Promise<Record<string, { path: string; exists: boolean }>>
  writeAgentConfig: (opts: {
    target:
      | 'claudeCode'
      | 'cursorUser'
      | 'codex'
      | 'gemini'
      | 'openCode'
      | 'mimoDesktop'
      | 'openclaw'
      | 'deepseekHarness'
      | 'kimiCode'
      | 'minimaxCode'
      | 'codebuddy'
      | 'workbuddy'
      | 'baiduComate'
      | 'byteTrae'
      | 'aliQoder'
      | 'aliLingma'
      | 'doubao'
      | 'marscode'
      | 'coze'
      | 'custom'
    path?: string
    baseUrl: string
    apiKey: string
    model?: string
  }) => Promise<{ ok: boolean; path?: string; error?: string }>
  onStatusUpdate: (callback: (statuses: Record<string, ProviderStatus>) => void) => () => void
}

export interface LatencyTestResult {
  ok: boolean
  latencyMs: number
  status?: number
  text?: string
  error?: string
  model: string
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
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
  website?: string
  note?: string
}

export interface CustomProvider extends Provider {
  createdAt: number
  updatedAt: number
}

export interface ProviderStatus {
  providerId: string
  keyIndex: number
  keyMask: string
  status: 'idle' | 'checking' | 'online' | 'offline' | 'error'
  latency: number | null
  /** Recent successful latencies (oldest → newest, cap 30) for the sparkline. */
  latencyHistory?: number[]
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

export interface Window {
  electronAPI: ElectronAPI
}
