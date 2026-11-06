import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { PROVIDERS, detectProvider } from './providers'
import { monitorEngine, ProviderStatus } from './monitor'
import {
  getApiKeys,
  setApiKeys,
  addApiKey,
  removeApiKey,
  getCustomProviders,
  addCustomProvider,
  updateCustomProvider,
  deleteCustomProvider,
  getSettings,
  updateSettings,
} from './store'

// ===== 内存极限压榨：全部实测验证后保留 =====
// 监控类应用的界面几乎全是静态卡片、低频刷新，不需要 GPU 硬件加速。
app.disableHardwareAcceleration()
// 限制渲染进程 V8 堆上限 + 暴露 gc()（隐藏窗口时手动触发全量 GC 用）
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=256 --expose-gc')
// 按需分配渲染器进程内存（Chromium 按使用比例而非预算分配）
app.commandLine.appendSwitch('renderer-process-limit', '1')
// 关闭后台节流豁免：监控页在后台时也保持低开销
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
// 关闭不需要的 Chromium 服务：拼写检查、翻译、自动填充通信等
app.commandLine.appendSwitch('disable-spell-checking')
// 停用站点隔离（本地单页面应用用不上，省去多余的安全渲染进程）
app.commandLine.appendSwitch('disable-site-isolation-trials')

let mainWindow: BrowserWindow | null = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow!.show()
  })

  // 窗口隐藏超过 1 分钟后向渲染进程发内存压力信号（触发 V8 GC）。
  let hideTimer: NodeJS.Timeout | null = null
  mainWindow.on('hide', () => {
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        // --js-flags=--expose-gc 已在启动开关中，window.gc() 可用
        mainWindow.webContents.executeJavaScript('window.gc ? window.gc() : 0').catch(() => {})
      }
    }, 60_000)
  })
  mainWindow.on('show', () => {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

ipcMain.handle('monitor:getProviders', () => {
  const custom = getCustomProviders()
  return [...PROVIDERS, ...custom]
})

ipcMain.handle('monitor:getKeys', () => {
  return getApiKeys()
})

ipcMain.handle('monitor:setKeys', (_event, keys: Record<string, string[]>) => {
  const prev = getApiKeys()
  setApiKeys(keys)
  for (const [pid, ks] of Object.entries(keys)) {
    monitorEngine.setKeys(pid, ks)
  }
  // Providers whose keys were all removed must stop polling too
  for (const pid of Object.keys(prev)) {
    if (!keys[pid] || keys[pid].length === 0) {
      monitorEngine.removeKeys(pid)
    }
  }
  return true
})

ipcMain.handle('monitor:addApiKey', (_event, providerId: string, keys: string[]) => {
  addApiKey(providerId, keys)
  const current = getApiKeys()
  monitorEngine.setKeys(providerId, current[providerId] || [])
  return true
})

ipcMain.handle('monitor:removeApiKey', (_event, providerId: string, keyIndex: number) => {
  removeApiKey(providerId, keyIndex)
  const current = getApiKeys()
  monitorEngine.setKeys(providerId, current[providerId] || [])
  return true
})

ipcMain.handle('monitor:getCustomProviders', () => {
  return getCustomProviders()
})

ipcMain.handle('monitor:addCustomProvider', (_event, provider: any) => {
  const newProvider = addCustomProvider(provider)
  monitorEngine.registerProviders([newProvider])
  return newProvider
})

ipcMain.handle('monitor:updateCustomProvider', (_event, id: string, updates: any) => {
  const updated = updateCustomProvider(id, updates)
  monitorEngine.registerProviders([updated])
  return updated
})

ipcMain.handle('monitor:deleteCustomProvider', (_event, id: string) => {
  deleteCustomProvider(id)
  monitorEngine.unregisterProvider(id)
  return true
})

ipcMain.handle('monitor:getSettings', () => {
  return getSettings()
})

ipcMain.handle('monitor:updateSettings', (_event, updates: any) => {
  updateSettings(updates)
  return true
})

ipcMain.handle('monitor:getStatuses', () => {
  const statuses = monitorEngine.getStatuses()
  return Object.fromEntries(statuses)
})

ipcMain.handle('monitor:setInterval', (_event, intervalMs: number) => {
  monitorEngine.setConfig({ intervalMs })
  return true
})

ipcMain.handle('monitor:start', (_event, providerIds: string[], intervalMs: number) => {
  monitorEngine.setConfig({ enabled: true, intervalMs })
  monitorEngine.setOnStatusChange((statuses: Map<string, ProviderStatus>) => {
    mainWindow?.webContents.send('monitor:statusUpdate', Object.fromEntries(statuses))
  })
  for (const id of providerIds) {
    if (monitorEngine.hasKeys(id)) {
      monitorEngine.startProvider(id)
    }
  }
  monitorEngine.startAll()
  return true
})

ipcMain.handle('monitor:stop', () => {
  monitorEngine.stopAll()
  monitorEngine.setConfig({ enabled: false })
  return true
})

ipcMain.handle('monitor:checkNow', (_event, providerId: string) => {
  monitorEngine.checkProvider(providerId)
  return true
})

ipcMain.handle('monitor:importCustom', (_event, customEntries: Array<{ baseUrl: string; key: string }>) => {
  return customEntries.map((entry) => {
    const matched = PROVIDERS.find((p) => entry.baseUrl.includes(p.baseUrl.replace('https://', '')))
    return { ...entry, providerId: matched?.id ?? 'custom' }
  })
})

ipcMain.handle('monitor:detectKey', async (_event, key: string) => {
  return monitorEngine.detectKey(key)
})

app.whenReady().then(() => {
  // Custom providers + persisted keys must be visible to the monitor engine
  monitorEngine.registerProviders(getCustomProviders())
  monitorEngine.seedKeys(getApiKeys())
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  monitorEngine.stopAll()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
