import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  getProviders: () => ipcRenderer.invoke('monitor:getProviders'),
  getKeys: () => ipcRenderer.invoke('monitor:getKeys'),
  getKeyLabels: () => ipcRenderer.invoke('monitor:getKeyLabels'),
  setKeyLabel: (key: string, label: string) => ipcRenderer.invoke('monitor:setKeyLabel', key, label),
  setKeys: (keys: Record<string, string[]>) => ipcRenderer.invoke('monitor:setKeys', keys),
  addApiKey: (providerId: string, keys: string[]) => ipcRenderer.invoke('monitor:addApiKey', providerId, keys),
  removeApiKey: (providerId: string, keyIndex: number) => ipcRenderer.invoke('monitor:removeApiKey', providerId, keyIndex),
  getCustomProviders: () => ipcRenderer.invoke('monitor:getCustomProviders'),
  addCustomProvider: (provider: any) => ipcRenderer.invoke('monitor:addCustomProvider', provider),
  updateCustomProvider: (id: string, updates: any) => ipcRenderer.invoke('monitor:updateCustomProvider', id, updates),
  deleteCustomProvider: (id: string) => ipcRenderer.invoke('monitor:deleteCustomProvider', id),
  getSettings: () => ipcRenderer.invoke('monitor:getSettings'),
  updateSettings: (updates: any) => ipcRenderer.invoke('monitor:updateSettings', updates),
  getStatuses: () => ipcRenderer.invoke('monitor:getStatuses'),
  setInterval: (intervalMs: number) => ipcRenderer.invoke('monitor:setInterval', intervalMs),
  startMonitoring: (providerIds: string[], intervalMs: number) =>
    ipcRenderer.invoke('monitor:start', providerIds, intervalMs),
  stopMonitoring: () => ipcRenderer.invoke('monitor:stop'),
  checkNow: (providerId: string, keyIndex?: number) => ipcRenderer.invoke('monitor:checkNow', providerId, keyIndex),
  importCustom: (entries: Array<{ baseUrl: string; key: string }>) =>
    ipcRenderer.invoke('monitor:importCustom', entries),
  detectKey: (key: string) => ipcRenderer.invoke('monitor:detectKey', key),
  mimoConnect: (keySuffix?: string) => ipcRenderer.invoke('monitor:mimoConnect', keySuffix),
  latencyTest: (opts: {
    providerId: string
    key: string
    model?: string
    text?: string
    maxTokens?: number
    timeoutMs?: number
  }) => ipcRenderer.invoke('monitor:latencyTest', opts),
  listModels: (providerId: string, key: string) =>
    ipcRenderer.invoke('monitor:listModels', providerId, key),
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  copyText: (text: string) => ipcRenderer.invoke('app:copyText', text),
  saveTextFile: (opts: { defaultName: string; content: string }) =>
    ipcRenderer.invoke('app:saveTextFile', opts),
  exportStatusCsv: () => ipcRenderer.invoke('app:exportStatusCsv'),
  // 消费账单（本地账本推导，不联网）
  getDailyReport: (days?: number, currency?: string) =>
    ipcRenderer.invoke('report:getDaily', days, currency),
  getUsageReport: (days?: number) => ipcRenderer.invoke('report:getUsage', days),
  // 通用 token 用量（本软件探测自身消耗，全厂商）
  getTokenReport: (days?: number) => ipcRenderer.invoke('report:getToken', days),
  exportReportCsv: (days?: number, currency?: string) =>
    ipcRenderer.invoke('report:exportCsv', days, currency),
  detectAgentConfigs: () => ipcRenderer.invoke('app:detectAgentConfigs'),
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
  }) => ipcRenderer.invoke('app:writeAgentConfig', opts),
  onStatusUpdate: (callback: (statuses: Record<string, unknown>) => void) => {
    ipcRenderer.on('monitor:statusUpdate', (_event, statuses) => callback(statuses))
    return () => {
      ipcRenderer.removeAllListeners('monitor:statusUpdate')
    }
  },
  // 监测开关的真实状态（托盘里点开始/停止、主进程自动恢复都会推过来）
  onMonitoringState: (callback: (state: { monitoring: boolean }) => void) => {
    ipcRenderer.on('monitor:state', (_event, state) => callback(state))
    return () => {
      ipcRenderer.removeAllListeners('monitor:state')
    }
  },
})
