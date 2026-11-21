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
  /**
   * 登录某把密钥所属的小米账号控制台（一个账号一条会话，互不串号）。
   * keySuffix = 那把密钥的尾 6 位；不传则只要求登录一个账号。
   */
  mimoConnect: (keySuffix?: string) => Promise<MimoConnectResult>
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
  /** 每日消费汇总（本地余额账本推导）。 */
  getDailyReport: (days?: number, currency?: string) => Promise<DailyReport>
  /** MiMo 控制台 token 用量（累计值差分，连了控制台才有数据）。 */
  getUsageReport: (days?: number) => Promise<UsageReport>
  /** 通用 token 用量：本软件探测自身消耗，按天 × 厂商聚合（全厂商可用）。 */
  getTokenReport: (days?: number) => Promise<TokenReport>
  /** 导出账单 CSV（带 BOM）。 */
  exportReportCsv: (days?: number, currency?: string) => Promise<{ ok: boolean; path?: string }>
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
  /** 监测开关的真实状态（托盘里点开始/停止、主进程自动恢复轮询都会推送） */
  onMonitoringState: (callback: (state: { monitoring: boolean }) => void) => () => void
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
  /** 被限流（429）后最早可再探测的时间戳；倒计时结束前不探测、不误报掉线。 */
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

/** 连接 MiMo 控制台的结果（按账号登录：一个小米账号一条会话，互不串号）。 */
export interface MimoConnectResult {
  ok: boolean
  /** 登录成功后拿到的控制台账号 id（cookie 里的 userId）。 */
  accountId?: string
  /** 该账号名下的密钥尾 6 位列表；接口失败时为 null。 */
  keySuffixes?: string[] | null
  /** 点「连接控制台」的那把 key 是否属于这个账号；false = 登错号了。 */
  keyFound?: boolean
  error?: string
}

/** 账单：每天每个厂商的消费金额。 */
export interface ReportProviderAmount {
  providerId: string
  name: string
  amount: number
}

export interface ReportDay {
  date: string
  total: number
  byProvider: ReportProviderAmount[]
}

export interface DailyReport {
  currency: string
  currencies: string[]
  days: ReportDay[]
  totals: { today: number; week: number; month: number; all: number }
  providerTotals: ReportProviderAmount[]
  sampleCount: number
  firstSampleAt: number | null
  lastSampleAt: number | null
}

export interface UsageDay {
  date: string
  tokens: number
  cost: number
}

export interface UsageReport {
  available: boolean
  days: UsageDay[]
  totalToken: number | null
  monthToken: number | null
  todayToken: number
  todayCost: number
  monthCost: number | null
  totalCost: number | null
  lastSampleAt: number | null
}

// 通用 token 用量（本软件探测自身消耗，全厂商）
export interface TokenProviderDay {
  providerId: string
  name: string
  prompt: number
  completion: number
  total: number
}

export interface TokenDay {
  date: string
  total: number
  byProvider: TokenProviderDay[]
}

export interface TokenReport {
  days: TokenDay[]
  todayToken: number
  weekToken: number
  monthToken: number
  allToken: number
  providerTotals: TokenProviderDay[]
  sampleCount: number
  firstDay: string | null
  lastDay: string | null
}

export interface Window {
  electronAPI: ElectronAPI
}
