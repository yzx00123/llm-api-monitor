import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { PROVIDERS, detectProvider } from './providers'
import { monitorEngine, ProviderStatus } from './monitor'
import { openMimoLoginWindow } from './mimo'
import {
  getApiKeys,
  setApiKeys,
  addApiKey,
  removeApiKey,
  getKeyLabels,
  setKeyLabel,
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

/**
 * Status push coalescing. updateStatus() fires once per key transition
 * (checking → result), and every call used to serialize the whole map over
 * IPC. Batch pushes so the renderer gets one snapshot per burst instead of
 * one per key transition.
 */
let statusPushTimer: NodeJS.Timeout | null = null
function scheduleStatusPush(): void {
  if (statusPushTimer) return
  statusPushTimer = setTimeout(() => {
    statusPushTimer = null
    if (!mainWindow || mainWindow.isDestroyed()) return
    const statuses = monitorEngine.getStatuses()
    // Strip balanceInfo.raw before crossing IPC — it can hold full API
    // response bodies and is never rendered in the UI.
    const out: Record<string, unknown> = {}
    for (const [k, s] of statuses) {
      const { balanceInfo, ...rest } = s as ProviderStatus & {
        balanceInfo?: { raw?: unknown } | null
      }
      out[k] =
        balanceInfo && balanceInfo.raw !== undefined
          ? { ...rest, balanceInfo: { ...balanceInfo, raw: undefined } }
          : s
    }
    mainWindow.webContents.send('monitor:statusUpdate', out)
  }, 120)
}

function bindStatusPush(): void {
  monitorEngine.setOnStatusChange(() => scheduleStatusPush())
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    // Dev runs under electron.exe (its embedded icon is the Electron atom
    // logo, which is what shows in the taskbar). Override with our .ico —
    // Windows needs ICO for taskbar/small-size rendering. Packaged builds
    // fall back to the exe icon that rcedit already embedded.
    icon: app.isPackaged ? undefined : join(__dirname, 'icon.ico'),
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

ipcMain.handle('monitor:getKeyLabels', () => {
  return getKeyLabels()
})

ipcMain.handle('monitor:setKeyLabel', (_event, key: string, label: string) => {
  setKeyLabel(key, label)
  return true
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
  // Accept optional slug as 供应商标识; fall back to generated id.
  const id =
    typeof provider?.id === 'string' && provider.id.trim()
      ? provider.id.trim().toLowerCase()
      : `custom-${Date.now()}`
  const newProvider = addCustomProvider({ ...provider, id })
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
  // Propagate interval changes to the running engine — previously only the
  // store was updated, so changing the interval did nothing until restart.
  if (typeof updates?.intervalMs === 'number') {
    monitorEngine.setConfig({ intervalMs: updates.intervalMs })
  }
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
  bindStatusPush()
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

ipcMain.handle('monitor:checkNow', (_event, providerId: string, keyIndex?: number) => {
  monitorEngine.checkProvider(providerId, keyIndex)
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

ipcMain.handle('monitor:mimoConnect', async () => {
  const ok = await openMimoLoginWindow(mainWindow)
  if (ok) {
    // Cookie just saved — refresh mimo balances immediately
    await monitorEngine.forceBalanceRefresh('mimo')
  }
  return ok
})

ipcMain.handle(
  'monitor:latencyTest',
  async (
    _event,
    opts: { providerId: string; key: string; model?: string; text?: string; maxTokens?: number; timeoutMs?: number }
  ) => {
    const result = await monitorEngine.latencyTest(opts)
    // Write the measured latency back onto the dashboard card for this key
    monitorEngine.recordLatencyResult(opts.providerId, opts.key, result)
    return result
  }
)

ipcMain.handle('monitor:listModels', async (_event, providerId: string, key: string) => {
  return monitorEngine.listModels(providerId, key)
})

ipcMain.handle('app:getVersion', () => {
  try {
    // electron-vite bundles from project root; package.json is one level up from out/main
    // Prefer app.getVersion() when packaged.
    return app.getVersion()
  } catch {
    return '0.0.0'
  }
})

app.whenReady().then(() => {
  // Custom providers + persisted keys must be visible to the monitor engine
  monitorEngine.registerProviders(getCustomProviders())
  monitorEngine.seedKeys(getApiKeys())

  // Status push must be live even before the user presses 开始 — the 测延迟
  // page writes latency onto dashboard cards and those updates must arrive.
  bindStatusPush()

  createWindow()

  // "以后打开软件自动开启" — resume monitoring once the window exists so
  // status pushes aren't dropped while mainWindow is still null.
  const settings = getSettings()
  if (settings.autoStart && Object.keys(getApiKeys()).length > 0) {
    monitorEngine.setConfig({ enabled: true, intervalMs: settings.intervalMs })
    bindStatusPush()
    monitorEngine.startAll()
  }

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
