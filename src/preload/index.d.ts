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
  importCustom: (entries: Array<{ baseUrl: string; key: string; providerId?: string }>) => Promise<ImportCustomResult>
  detectKey: (key: string) => Promise<string | null>
  /**
   * 登录某把密钥所属的小米账号控制台（一个账号一条会话，互不串号）。
   * keySuffix = 那把密钥的尾 6 位；不传则只要求登录一个账号。
   */
  mimoConnect: (keySuffix?: string) => Promise<MimoConnectResult>
  /**
   * 阿里云百炼免费额度（按模型统计，数据来自控制台内部接口）。
   * force = true 时忽略 5 分钟缓存重新拉。
   */
  bailianGetQuota: (force?: boolean) => Promise<FreeQuotaResult>
  /** 打开百炼控制台让用户登录，登录成功后返回额度。 */
  bailianLogin: () => Promise<BailianLoginResult>
  /** 退出百炼控制台登录（清 cookie）。 */
  bailianLogout: () => Promise<{ ok: boolean }>
  /** 读取已导入的小米 MiMo 历史账单汇总。 */
  mimoGetBills: () => Promise<MimoBillSummary>
  /** 从 MiMo 控制台导入最近 N 个月的历史账单（默认 12）。 */
  mimoImportBills: (months?: number) => Promise<MimoBillSummary>
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
  detectAgentConfigs: () => Promise<AgentTargetInfo[]>
  /** 预演写入：返回「如果现在写入，这些文件会变成什么样」。 */
  previewAgentConfig: (opts: AgentExportOptions) => Promise<AgentPlan>
  /** 真正写入：先备份、再写、最后回读校验。 */
  writeAgentConfig: (opts: AgentExportOptions) => Promise<AgentWriteResult>
  onStatusUpdate: (callback: (statuses: Record<string, ProviderStatus>) => void) => () => void
  /** 监测开关的真实状态（托盘里点开始/停止、主进程自动恢复轮询都会推送） */
  onMonitoringState: (callback: (state: { monitoring: boolean }) => void) => () => void
  /** 文件导入时主进程可能自动新建自定义供应商，界面收到后应重新拉供应商列表 */
  onProvidersChanged: (callback: (createdIds: string[]) => void) => () => void
}

export interface ImportCustomResult {
  /** 真正新增的密钥数量（已存在的会跳过） */
  imported: number
  /** 这次导入顺手新建的自定义供应商 id 列表 */
  createdIds: string[]
  /** 每条密钥最终归属的供应商 */
  results: Array<{ providerId: string; key: string; created: boolean }>
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

/** 百炼免费额度里的一行（一个模型）。 */
export interface FreeQuotaRow {
  model: string
  modelType: 'Text' | 'Vision' | 'Multimodal' | 'Audio' | 'Embedding'
  /** 剩余 Token。 */
  remaining: number
  /** 发放总量（通常是 1,000,000）。 */
  total: number
  /** 剩余百分比 0~100。 */
  remainPercentage?: number
  /** 到期时间（毫秒时间戳）；缺省表示每月重置/长期有效。 */
  expireAt?: number
  /** 还有额度且没过期。 */
  isValid: boolean
  /** 「用完即停」是否开启。 */
  stopOnExhaust: boolean
}

/** 免费额度汇总（对应控制台顶部四张卡）。 */
export interface FreeQuotaSummary {
  withQuota: number
  over50: number
  over80: number
  exhaustedOrExpired: number
  total: number
  remainingTokens: number
  totalTokens: number
}

export interface FreeQuotaResult {
  ok: boolean
  /** 是否已登录百炼控制台。 */
  loggedIn: boolean
  rows: FreeQuotaRow[]
  summary: FreeQuotaSummary
  fetchedAt: number
  error?: string
}

export interface BailianLoginResult {
  ok: boolean
  rows?: FreeQuotaRow[]
  summary?: FreeQuotaSummary
  error?: string
}

/** 小米 MiMo 历史账单（从控制台导入，按天 × 模型 × 密钥）。 */
export interface MimoBillDay {
  date: string
  cost: number
  token: number
  requests: number
}

export interface MimoBillModel {
  model: string
  cost: number
  token: number
}

export interface MimoBillSummary {
  ok: boolean
  /** 最后一次导入时间；没导入过是 null。 */
  importedAt: number | null
  /** 明细条数。 */
  rows: number
  /** 覆盖范围（首/末日期）。 */
  first: string | null
  last: string | null
  totalCost: number
  totalToken: number
  requests: number
  days: MimoBillDay[]
  models: MimoBillModel[]
  /** 本次拉取的明细条数（仅导入时返回）。 */
  fetched?: number
  /** 各月拉取情况（仅导入时返回）。 */
  months?: Array<{ year: number; month: number; rows: number; cost: number }>
  /** true = 控制台登录态失效，需要重新点「连接控制台」。 */
  needLogin?: boolean
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

// ── 导出到 Agent ──────────────────────────────────────────────────
export type AgentTargetId =
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

export interface AgentTargetInfo {
  id: AgentTargetId
  label: string
  group: '国际' | '国内'
  format: 'json' | 'jsonc' | 'toml' | 'yaml' | 'env' | 'manual'
  /** 配置文件绝对路径 */
  path: string
  /** 配置文件是否已存在 */
  exists: boolean
  /** 是否找到真实安装证据（命令行 / 安装目录） */
  installed: boolean
  /** 证据说明，如「安装目录 C:\\Users\\…\\AppData\\Roaming\\Xiaomi MiMo」 */
  evidence: string | null
  /** 写进文件里哪一块 */
  writes: string
  note?: string
  /** 通道可信度：verified=本机真实配置验证过，documented=官方文档，guessed=推测路径 */
  confidence: 'verified' | 'documented' | 'guessed'
}

export interface AgentExportOptions {
  target: AgentTargetId | 'custom'
  path?: string
  baseUrl: string
  apiKey: string
  model?: string
  providerName?: string
  /** 供应商 id / 原生协议：用来判断这把密钥能不能喂进只认某种协议的 Agent */
  providerId?: string
  providerProtocol?: 'openai' | 'anthropic' | 'gemini'
}

export interface AgentFilePlan {
  path: string
  content: string
  language: 'json' | 'jsonc' | 'toml' | 'yaml' | 'env' | 'text'
}

export interface AgentPlan {
  ok: boolean
  target: string
  path: string
  files: AgentFilePlan[]
  /** 只能复制、不能直接写文件（例如 Cursor） */
  manual: boolean
  note?: string
  error?: string
}

export interface AgentWriteResult {
  ok: boolean
  path: string
  files: string[]
  error?: string
}

export interface Window {
  electronAPI: ElectronAPI
}
