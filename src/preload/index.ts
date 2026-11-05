import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  getProviders: () => ipcRenderer.invoke('monitor:getProviders'),
  getKeys: () => ipcRenderer.invoke('monitor:getKeys'),
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
  checkNow: (providerId: string) => ipcRenderer.invoke('monitor:checkNow', providerId),
  importCustom: (entries: Array<{ baseUrl: string; key: string }>) =>
    ipcRenderer.invoke('monitor:importCustom', entries),
  detectKey: (key: string) => ipcRenderer.invoke('monitor:detectKey', key),
  onStatusUpdate: (callback: (statuses: Record<string, unknown>) => void) => {
    ipcRenderer.on('monitor:statusUpdate', (_event, statuses) => callback(statuses))
    return () => {
      ipcRenderer.removeAllListeners('monitor:statusUpdate')
    }
  },
})
