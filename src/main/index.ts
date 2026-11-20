import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  clipboard,
  dialog,
  Notification,
  Tray,
  Menu,
  nativeImage,
} from 'electron'
import { join } from 'path'
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { PROVIDERS, detectProvider } from './providers'
import { monitorEngine, MonitorEngine, ProviderStatus, StatusAlert } from './monitor'
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
  appendBalanceSample,
  appendUsageSample,
  appendProbeUsage,
  getProbeUsage,
  clearBrokeAlerted,
} from './store'
import { buildDailyReport, buildUsageReport, buildReportCsv, buildTokenReport } from './report'

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
// Windows 通知（toast）需要固定 AUMID，否则 Notification 静默失败
app.setAppUserModelId('com.yzx00123.llm-api-monitor')

// 单实例锁：重复启动（双击 exe、快捷方式、任务栏再点开）时不新开窗口和
// 托盘图标，而是把已经在跑的那个实例唤到前面来。否则会出现两个窗口、
// 两个托盘图标，监测也会跑两份。
const isPrimaryInstance = app.requestSingleInstanceLock()
if (!isPrimaryInstance) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
/** Set before app.quit() so the close handler doesn't swallow it into the tray. */
let isQuitting = false
/** One-time "已最小化到托盘" hint so the first close isn't confusing. */
let trayHintShown = false

/**
 * Status push coalescing. updateStatus() fires once per key transition
 * (checking → result), and every call used to serialize the whole map over
 * IPC. Batch pushes so the renderer gets one snapshot per burst instead of
 * one per key transition.
 */
let statusPushTimer: NodeJS.Timeout | null = null

/**
 * Strip balanceInfo.raw before crossing IPC — it can hold full API response
 * bodies and is never rendered in the UI. Shared by the push path and
 * monitor:getStatuses (which used to leak it).
 */
function sanitizeStatuses(statuses: Map<string, ProviderStatus>): Record<string, unknown> {
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
  return out
}

function scheduleStatusPush(): void {
  if (statusPushTimer) return
  statusPushTimer = setTimeout(() => {
    statusPushTimer = null
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('monitor:statusUpdate', sanitizeStatuses(monitorEngine.getStatuses()))
  }, 120)
}

function bindStatusPush(): void {
  monitorEngine.setOnStatusChange(() => scheduleStatusPush())
}

// ===== 告警通知（掉线 / 余额不足 / 恢复） =====

function showNotification(title: string, body: string, silent = true): void {
  try {
    if (!Notification.isSupported()) return
    const n = new Notification({ title, body, silent })
    n.show()
  } catch {
    // 通知失败不影响监测本身
  }
}

/** Per alert-kind cooldown so a flapping key can't spam the notification center. */
const alertCooldown: Map<string, number> = new Map()
const ALERT_COOLDOWN_MS = 60_000
/** App launch time — 启动宽限期的起点（见 handleAlert）。 */
const appStartedAt = Date.now()
/** 本次会话里真正播报过「掉线」的 key —— 播报过「恢复」才有效（配对）。 */
const announcedDown: Set<string> = new Set<string>()

function providerDisplayName(providerId: string): string {
  return (
    PROVIDERS.find((p) => p.id === providerId)?.name ??
    getCustomProviders().find((p) => p.id === providerId)?.name ??
    providerId
  )
}

function handleAlert(alert: StatusAlert): void {
  const settings = getSettings()
  const statusKey = `${alert.providerId}#${alert.keyIndex}`
  console.log(`[alert] in ${alert.kind} ${statusKey}`)

  // 「余额不足 / 余额恢复」一律不弹通知（用户要求）：
  // 余额状态在仪表盘卡片徽章与账单页随时可查，弹窗纯属打扰。
  // 恢复时仍清除旧的「已提醒」记忆，避免配置里残留过期数据。
  if (alert.kind === 'broke') return
  if (alert.kind === 'refilled') {
    clearBrokeAlerted(statusKey)
    return
  }

  // 走到这里 kind 只剩 down / recovered（broke/refilled 已在上面拦截）。
  const isRecovery = alert.kind === 'recovered'
  if (isRecovery && !settings.alertOnRecovery) return
  if (!isRecovery && !settings.alertsEnabled) return

  // 启动宽限期：打开软件后的头几轮探测常赶上网络/DNS 未就绪，
  // 期间的掉线都是抖动，不弹通知（仪表盘状态照常显示）。
  // 宽限期 = 3 个探测周期（掉线判定所需的连续失败窗口）+ 1 分钟，上限 30 分钟。
  if (alert.kind === 'down') {
    const graceMs = Math.min(3 * settings.intervalMs + 60_000, 30 * 60_000)
    if (Date.now() - appStartedAt < graceMs) return
  }
  // 配对：本次会话没播报过「掉线」就不播报「已恢复」——
  // 打开软件首轮探测失败、下一轮成功产生的"假恢复"由此被挡掉。
  if (alert.kind === 'recovered' && !announcedDown.has(statusKey)) return

  const throttleKey = `${alert.providerId}#${alert.keyIndex}:${alert.kind}`
  const now = Date.now()
  const last = alertCooldown.get(throttleKey) ?? 0
  if (now - last < ALERT_COOLDOWN_MS) return
  alertCooldown.set(throttleKey, now)

  const name = providerDisplayName(alert.providerId)
  const label = `${name} · ${alert.keyMask}`
  let title: string
  let body: string
  switch (alert.kind) {
    case 'down':
      title = `⚠️ ${label} 掉线`
      body = alert.detail || '连续多次探测失败'
      break
    case 'recovered':
      title = `✅ ${label} 已恢复`
      body = '探测恢复正常'
      break
  }
  console.log(`[alert] show ${alert.kind} ${statusKey}`)
  showNotification(title, body, !settings.alertSound)

  // 播报记账：供「掉线↔恢复」配对判断
  if (alert.kind === 'down') announcedDown.add(statusKey)
  else if (alert.kind === 'recovered') announcedDown.delete(statusKey)
}

// ===== 系统托盘 + 后台驻留 =====

function showMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
  } else {
    createWindow()
  }
}

function createTray(): void {
  if (tray) return
  const iconPath = join(__dirname, 'icon.ico')
  const icon = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
  tray = new Tray(icon)
  tray.setToolTip('LLM API Monitor')

  const menu = Menu.buildFromTemplate([
    {
      label: '打开主界面',
      click: () => showMainWindow(),
    },
    { type: 'separator' },
    {
      label: '开始监测',
      click: () => {
        monitorEngine.setConfig({ enabled: true })
        monitorEngine.startAll()
      },
    },
    {
      label: '停止监测',
      click: () => {
        monitorEngine.stopAll()
        monitorEngine.setConfig({ enabled: false })
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ])

  // 左键唤出主界面，右键弹菜单（Windows 上 setContextMenu 会把左键也变成菜单）
  tray.on('click', () => showMainWindow())
  tray.on('right-click', () => tray?.popUpContextMenu(menu))
  tray.on('double-click', () => showMainWindow())
}

// ===== 状态快照 CSV 导出 =====

function csvEscape(v: unknown): string {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function buildStatusCsv(): string {
  const labels = getKeyLabels()
  const keys = getApiKeys()
  const statuses = monitorEngine.getStatuses()
  const statusLabel: Record<string, string> = {
    idle: '未检测',
    checking: '检测中',
    online: '在线',
    offline: '离线',
    error: '异常',
  }

  const rows: string[] = [
    ['供应商', '备注', '密钥', '状态', '延迟(ms)', '认证', '余额', '币种', '错误', '上次检测'].join(','),
  ]
  for (const [pid, ks] of Object.entries(keys)) {
    for (let i = 0; i < ks.length; i++) {
      const s = statuses.get(`${pid}#${i}`)
      const d = new Date(s?.lastChecked ?? Date.now())
      const pad = (n: number) => String(n).padStart(2, '0')
      const time = s?.lastChecked
        ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
        : ''
      rows.push(
        [
          providerDisplayName(pid),
          labels[ks[i]] ?? '',
          MonitorEngine.maskKey(ks[i]),
          statusLabel[s?.status ?? 'idle'] ?? s?.status ?? '',
          s?.latency ?? '',
          s?.authStatus ?? '',
          s?.balanceInfo?.available ?? '',
          s?.balanceInfo?.currency ?? '',
          s?.errorCode ?? '',
          time,
        ]
          .map(csvEscape)
          .join(',')
      )
    }
  }
  return rows.join('\r\n') + '\r\n'
}

ipcMain.handle('app:exportStatusCsv', async () => {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const saveOpts = {
    defaultPath: `LLM-Monitor-快照_${stamp}.csv`,
    filters: [{ name: 'CSV 文件', extensions: ['csv'] }],
  }
  const result = mainWindow
    ? await dialog.showSaveDialog(mainWindow, saveOpts)
    : await dialog.showSaveDialog(saveOpts)
  if (result.canceled || !result.filePath) return { ok: false }
  // BOM 让 Excel 直接双击打开中文不乱码
  writeFileSync(result.filePath, '\uFEFF' + buildStatusCsv(), 'utf-8')
  return { ok: true, path: result.filePath }
})

// ===== 消费账单（每日花费 / token 用量） =====
// 数据来自本地余额账本，纯本机计算，不联网。

ipcMain.handle('report:getDaily', (_event, days?: number, currency?: string) =>
  buildDailyReport(days ?? 30, currency)
)

ipcMain.handle('report:getUsage', (_event, days?: number) => buildUsageReport(days ?? 30))

// 通用 token 用量：本软件探测自身消耗，按天 × 厂商聚合（全厂商通用）。
ipcMain.handle('report:getToken', (_event, days?: number) => buildTokenReport(days ?? 30))

ipcMain.handle('report:exportCsv', async (_event, days?: number, currency?: string) => {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const saveOpts = {
    defaultPath: `LLM-Monitor-账单_${stamp}.csv`,
    filters: [{ name: 'CSV 文件', extensions: ['csv'] }],
  }
  const result = mainWindow
    ? await dialog.showSaveDialog(mainWindow, saveOpts)
    : await dialog.showSaveDialog(saveOpts)
  if (result.canceled || !result.filePath) return { ok: false }
  writeFileSync(result.filePath, buildReportCsv(days ?? 30, currency), 'utf-8')
  return { ok: true, path: result.filePath }
})

function createWindow() {  mainWindow = new BrowserWindow({
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

  // 关窗驻留后台：关闭按钮只是隐藏窗口，监测继续跑，托盘一键唤出。
  // 托盘菜单「退出」会先置 isQuitting，真正退出。
  mainWindow.on('close', (e) => {
    if (!isQuitting && getSettings().minimizeToTray) {
      e.preventDefault()
      mainWindow?.hide()
      if (!trayHintShown) {
        trayHintShown = true
        showNotification(
          'LLM API Monitor 仍在后台运行',
          '已最小化到托盘，监测继续。左键托盘图标可唤出，右键可退出。'
        )
      }
    }
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
    const prevList = prev[pid] ?? []
    // 新导入的 key 立即探测一次，不等下一个轮询间隔。
    const added = ks.map((k, i) => (prevList.includes(k) ? -1 : i)).filter((i) => i >= 0)
    monitorEngine.setKeys(pid, ks, added)
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
  const list = current[providerId] || []
  // 刚导入的几把 key 立即探测一次，不等下一个轮询间隔。
  const added = list.map((k, i) => (keys.includes(k) ? i : -1)).filter((i) => i >= 0)
  monitorEngine.setKeys(providerId, list, added)
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
  return sanitizeStatuses(monitorEngine.getStatuses())
})

ipcMain.handle('monitor:setInterval', (_event, intervalMs: number) => {
  monitorEngine.setConfig({ intervalMs })
  return true
})

ipcMain.handle('monitor:start', (_event, _providerIds: string[], intervalMs: number) => {
  // setConfig({enabled, intervalMs}) 内部已 stopAll + startAll 启动全部有密钥的
  // 供应商——下面的逐个 startProvider + startAll 是重复启动，会让打开/开始瞬间
  // 背靠背跑多轮探测（第一轮的"网络未就绪失败→下一轮成功"就是弹窗的来源）。
  monitorEngine.setConfig({ enabled: true, intervalMs })
  bindStatusPush()
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
    // app.getVersion() can resolve to the Electron runtime's version when
    // running unpackaged (electron out/main/index.js) — the sidebar showed
    // v33.4.11 (Electron) instead of the app version. Read package.json
    // from the app root first, fall back to app.getVersion() when packaged.
    const pkgPath = join(app.getAppPath(), 'package.json')
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string }
      if (pkg.version) return pkg.version
    }
    return app.getVersion()
  } catch {
    return '0.0.0'
  }
})

/** Copy raw text (API key, env snippet…) to the system clipboard. */
ipcMain.handle('app:copyText', (_event, text: string) => {
  clipboard.writeText(String(text ?? ''))
  return true
})

/** Save a text snippet as a file chosen by the user. */
ipcMain.handle('app:saveTextFile', async (_event, opts: { defaultName: string; content: string }) => {
  const win = mainWindow ?? undefined
  const result = await dialog.showSaveDialog(win!, {
    defaultPath: opts.defaultName,
    filters: [
      { name: '配置文件', extensions: ['env', 'json', 'toml', 'txt'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  })
  if (result.canceled || !result.filePath) return { ok: false }
  writeFileSync(result.filePath, opts.content ?? '', 'utf-8')
  return { ok: true, path: result.filePath }
})

/** Probe which agent config files exist so the UI can offer "write in place". */
ipcMain.handle('app:detectAgentConfigs', () => {
  const home = homedir()
  const candidates: Record<string, string> = {
    claudeCode: join(home, '.claude', 'settings.json'),
    cursorUser: join(home, '.cursor', 'mcp.json'),
    codex: join(home, '.codex', 'config.toml'),
    gemini: join(home, '.gemini', 'settings.json'),
    openCode: join(home, '.config', 'opencode', 'opencode.json'),
    // 国内 / 本地 Agent
    mimoDesktop: join(home, '.config', 'mimocode', 'mimocode.jsonc'),
    openclaw: join(home, '.openclaw', 'openclaw.json'),
    deepseekHarness: join(home, '.deepseek-harness', 'config.json'),
    kimiCode: join(home, '.kimi', 'config.json'),
    minimaxCode: join(home, '.minimax-code', 'config.json'),
    // 腾讯 / 百度 / 字节 / 阿里
    codebuddy: join(home, '.codebuddy', 'settings.json'),
    workbuddy: join(home, '.workbuddy', 'config.json'),
    baiduComate: join(home, '.comate', 'mcp.local.json'),
    byteTrae: join(home, '.trae', 'config.json'),
    aliQoder: join(home, '.qoder', 'config.json'),
    aliLingma: join(home, '.lingma', 'config.json'),
    // 字节豆包 / MarsCode / 扣子
    doubao: join(home, '.doubao', 'config.json'),
    marscode: join(home, '.marscode', 'config.json'),
    coze: join(home, '.coze', 'config.json'),
  }
  const found: Record<string, { path: string; exists: boolean }> = {}
  for (const [k, p] of Object.entries(candidates)) {
    found[k] = { path: p, exists: existsSync(p) }
  }
  return found
})

/**
 * Write API env/JSON into a real agent config. Only touches known safe keys —
 * merges into existing JSON rather than overwriting the whole file.
 */
ipcMain.handle(
  'app:writeAgentConfig',
  async (
    _event,
    opts: {
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
    }
  ) => {
    const home = homedir()
    const defaultPaths: Record<string, string> = {
      claudeCode: join(home, '.claude', 'settings.json'),
      cursorUser: join(home, '.cursor', 'mcp.json'),
      codex: join(home, '.codex', 'config.toml'),
      gemini: join(home, '.gemini', 'settings.json'),
      openCode: join(home, '.config', 'opencode', 'opencode.json'),
      mimoDesktop: join(home, '.config', 'mimocode', 'mimocode.jsonc'),
      openclaw: join(home, '.openclaw', 'openclaw.json'),
      deepseekHarness: join(home, '.deepseek-harness', 'config.json'),
      kimiCode: join(home, '.kimi', 'config.json'),
      minimaxCode: join(home, '.minimax-code', 'config.json'),
      codebuddy: join(home, '.codebuddy', 'settings.json'),
      workbuddy: join(home, '.workbuddy', 'config.json'),
      baiduComate: join(home, '.comate', 'mcp.local.json'),
      byteTrae: join(home, '.trae', 'config.json'),
      aliQoder: join(home, '.qoder', 'config.json'),
      aliLingma: join(home, '.lingma', 'config.json'),
      doubao: join(home, '.doubao', 'config.json'),
      marscode: join(home, '.marscode', 'config.json'),
      coze: join(home, '.coze', 'config.json'),
    }
    const targetPath = opts.path?.trim() || defaultPaths[opts.target]
    if (!targetPath) return { ok: false, error: '缺少目标路径' }

    try {
      mkdirSync(join(targetPath, '..'), { recursive: true })
      const model = opts.model?.trim() || ''
      const providerId = 'llm-monitor'

      // ── TOML (Codex config) ──────────────────────────────────────
      if (targetPath.endsWith('.toml')) {
        let text = existsSync(targetPath) ? readFileSync(targetPath, 'utf-8') : ''
        const block = [
          '',
          '# --- LLM API Monitor 导出 ---',
          `[providers.llm-monitor]`,
          `base_url = "${opts.baseUrl}"`,
          `api_key = "${opts.apiKey}"`,
          model ? `model = "${model}"` : '',
          '',
        ]
          .filter(Boolean)
          .join('\n')
        text = text.replace(/\n# --- LLM API Monitor 导出 ---[\s\S]*$/m, '')
        writeFileSync(targetPath, text.trimEnd() + '\n' + block, 'utf-8')
        return { ok: true, path: targetPath }
      }

      // ── MiMo Desktop mimocode.jsonc (JSONC + provider map) ──────
      if (opts.target === 'mimoDesktop') {
        const raw = existsSync(targetPath) ? readFileSync(targetPath, 'utf-8') : '{}'
        // strip // line comments and /* */ blocks before parsing
        const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
        let data: Record<string, any>
        try {
          data = JSON.parse(stripped)
        } catch {
          return { ok: false, error: 'mimocode.jsonc 解析失败，已取消写入' }
        }
        data.provider = data.provider ?? {}
        data.provider[providerId] = {
          name: 'LLM API Monitor',
          npm: '@ai-sdk/openai-compatible',
          only_configured_models: true,
          options: {
            apiKey: opts.apiKey,
            baseURL: opts.baseUrl,
          },
          models: model
            ? { [model]: { name: model } }
            : {},
        }
        writeFileSync(targetPath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
        return { ok: true, path: targetPath }
      }

      // ── OpenClaw openclaw.json (JSON5-style: unquoted top keys) ──
      if (opts.target === 'openclaw') {
        let text = existsSync(targetPath) ? readFileSync(targetPath, 'utf-8') : '{}'
        // quote bare top-level keys so we can parse as JSON
        const normalized = text.replace(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/gm, '$1"$2":')
        let data: Record<string, any>
        try {
          data = JSON.parse(normalized)
        } catch {
          return { ok: false, error: 'openclaw.json 解析失败，已取消写入' }
        }
        data.models = data.models ?? {}
        data.models.mode = data.models.mode ?? 'merge'
        data.models.providers = data.models.providers ?? {}
        data.models.providers[providerId] = {
          baseUrl: opts.baseUrl,
          apiKey: opts.apiKey,
          api: 'openai-completions',
          models: model
            ? [{ id: model, name: model, contextWindow: 128000, maxTokens: 8192 }]
            : [],
        }
        writeFileSync(targetPath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
        return { ok: true, path: targetPath }
      }

      // ── JSON configs — merge env-style fields without clobbering. ─
      let data: Record<string, any> = {}
      if (existsSync(targetPath)) {
        try {
          data = JSON.parse(readFileSync(targetPath, 'utf-8'))
        } catch {
          return { ok: false, error: '原文件不是合法 JSON，已取消写入' }
        }
      }

      if (opts.target === 'claudeCode' || opts.target === 'gemini') {
        data.env = {
          ...(data.env ?? {}),
          ANTHROPIC_API_KEY: opts.apiKey,
          ANTHROPIC_BASE_URL: opts.baseUrl,
          OPENAI_API_KEY: opts.apiKey,
          OPENAI_BASE_URL: opts.baseUrl,
          GEMINI_API_KEY: opts.apiKey,
          GOOGLE_GEMINI_BASE_URL: opts.baseUrl,
        }
        if (model) data.model = model
      } else if (opts.target === 'cursorUser') {
        // Cursor mcp.json: record as a note under _llmMonitor so we don't
        // corrupt mcpServers (which has a different schema).
        data._llmMonitor = {
          baseUrl: opts.baseUrl,
          apiKey: opts.apiKey,
          model: model || null,
          exportedAt: new Date().toISOString(),
        }
      } else if (
        opts.target === 'deepseekHarness' ||
        opts.target === 'kimiCode' ||
        opts.target === 'minimaxCode' ||
        opts.target === 'byteTrae' ||
        opts.target === 'aliQoder' ||
        opts.target === 'aliLingma'
      ) {
        // Domestic agents: standard OpenAI-compatible provider block.
        data.provider = data.provider ?? {}
        data.provider[providerId] = {
          baseUrl: opts.baseUrl,
          apiKey: opts.apiKey,
          api: 'openai-completions',
          model: model || undefined,
        }
      } else if (opts.target === 'codebuddy' || opts.target === 'workbuddy') {
        // 腾讯 CodeBuddy / WorkBuddy: env-style + provider fallback.
        // CodeBuddy CLI reads CODEBUDDY_API_KEY / CODEBUDDY_BASE_URL.
        data.env = {
          ...(data.env ?? {}),
          CODEBUDDY_API_KEY: opts.apiKey,
          CODEBUDDY_BASE_URL: opts.baseUrl,
          OPENAI_API_KEY: opts.apiKey,
          OPENAI_BASE_URL: opts.baseUrl,
        }
        data.provider = data.provider ?? {}
        data.provider[providerId] = {
          baseUrl: opts.baseUrl,
          apiKey: opts.apiKey,
          api: 'openai-completions',
          model: model || undefined,
        }
      } else if (opts.target === 'doubao') {
        // 字节豆包: DOUBAO_API_KEY is the documented auth env; also keep an
        // OpenAI-compatible provider block for clients that read one.
        data.env = {
          ...(data.env ?? {}),
          DOUBAO_API_KEY: opts.apiKey,
          DOUBAO_BASE_URL: opts.baseUrl,
          OPENAI_API_KEY: opts.apiKey,
          OPENAI_BASE_URL: opts.baseUrl,
        }
        data.provider = data.provider ?? {}
        data.provider[providerId] = {
          baseUrl: opts.baseUrl,
          apiKey: opts.apiKey,
          api: 'openai-completions',
          model: model || undefined,
        }
      } else if (opts.target === 'marscode' || opts.target === 'coze') {
        // 字节 MarsCode / 扣子 Coze: standard OpenAI-compatible block + env.
        data.env = {
          ...(data.env ?? {}),
          OPENAI_API_KEY: opts.apiKey,
          OPENAI_BASE_URL: opts.baseUrl,
        }
        data.provider = data.provider ?? {}
        data.provider[providerId] = {
          baseUrl: opts.baseUrl,
          apiKey: opts.apiKey,
          api: 'openai-completions',
          model: model || undefined,
        }
      } else if (opts.target === 'baiduComate') {
        // 百度文心快码 Comate: keep existing keys, add ours under providers.
        data.provider = data.provider ?? {}
        data.provider[providerId] = {
          baseUrl: opts.baseUrl,
          apiKey: opts.apiKey,
          api: 'openai-completions',
          model: model || undefined,
        }
      } else {
        data.baseUrl = opts.baseUrl
        data.apiKey = opts.apiKey
        if (model) data.model = model
      }

      writeFileSync(targetPath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
      return { ok: true, path: targetPath }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
)

app.whenReady().then(() => {
  // 已经有一个实例在跑：本进程直接退出，不建窗口/托盘/监测
  if (!isPrimaryInstance) return
  // Custom providers + persisted keys must be visible to the monitor engine
  monitorEngine.registerProviders(getCustomProviders())
  monitorEngine.seedKeys(getApiKeys())

  // Status push must be live even before the user presses 开始 — the 测延迟
  // page writes latency onto dashboard cards and those updates must arrive.
  bindStatusPush()
  // 掉线 / 余额不足 → 系统通知
  monitorEngine.setOnAlert(handleAlert)
  // 余额 / MiMo 累计用量样本 → 本地账本（消费账单的数据源）
  monitorEngine.setOnBalanceSample((sample) => appendBalanceSample({ ...sample, t: Date.now() }))
  monitorEngine.setOnUsageSample((sample) => appendUsageSample({ ...sample, t: Date.now() }))
  // 探测自身消耗的 token → 本地按天账本（通用 token 用量，全厂商）
  monitorEngine.setOnProbeUsage((usage) => appendProbeUsage(usage.providerId, Date.now(), usage))
  // 系统托盘：关窗后监测继续，托盘一键唤出
  createTray()

  createWindow()

  // "以后打开软件自动开启" — resume monitoring once the window exists so
  // status pushes aren't dropped while mainWindow is still null.
  const settings = getSettings()
  if (settings.autoStart && Object.keys(getApiKeys()).length > 0) {
    // setConfig 在 enabled + intervalMs 变化时内部已 stopAll + startAll——
    // 这里再 startAll() 是重复启动，是"一打开软件就弹两个提示"的来源之一。
    monitorEngine.setConfig({ enabled: true, intervalMs: settings.intervalMs })
    bindStatusPush()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  isQuitting = true
})

app.on('window-all-closed', () => {
  monitorEngine.stopAll()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
