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
import { writeFileSync, readFileSync, existsSync, mkdirSync, copyFileSync } from 'fs'
import { homedir } from 'os'
import { PROVIDERS, detectProvider } from './providers'
import { monitorEngine, MonitorEngine, ProviderStatus, StatusAlert } from './monitor'
import { openMimoLoginWindow } from './mimo'
import { getFreeQuota, logoutBailian, openBailianLogin } from './bailianQuota'
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
  migrateMimoSessions,
  syncFlushSamples,
} from './store'
import { buildDailyReport, buildUsageReport, buildReportCsv, buildTokenReport } from './report'
import {
  applyAgentExport,
  detectAgentTargets,
  planAgentExport,
  type AgentExportOptions,
} from './agentExport'

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
/** 启动宽限期内被压下的掉线播报：宽限期结束后仍未恢复就补报（见 handleAlert）。 */
const pendingDownAlerts: Map<string, StatusAlert> = new Map()

/**
 * 宽限期结束后补报一次被压下的掉线。
 *
 * 不这样做的话：打开软件头几分钟内网络未就绪导致的掉线会被宽限期「吞掉」——
 * monitor 只在状态由好变坏的那一刻发一次 down，之后不会再发；而「已恢复」的播报
 * 又要求 announcedDown 里有记录。结果是整个故障期既不报掉线也不报恢复。
 */
function replayPendingDown(statusKey: string, alert: StatusAlert, delayMs: number): void {
  setTimeout(() => {
    if (!pendingDownAlerts.has(statusKey)) return
    pendingDownAlerts.delete(statusKey)
    const st = monitorEngine.getStatuses().get(statusKey)
    // 宽限期结束时已经恢复（或还在检测中）就别补报了，避免真正的噪音。
    if (!st || st.status === 'online' || st.status === 'checking' || st.status === 'idle') return
    handleAlert(alert)
  }, Math.max(0, delayMs))
}

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
    const elapsed = Date.now() - appStartedAt
    if (elapsed < graceMs) {
      // 压住（不是丢弃）：宽限期结束若仍然掉线，由 replayPendingDown 补报一次。
      pendingDownAlerts.set(statusKey, alert)
      replayPendingDown(statusKey, alert, graceMs - elapsed + 500)
      return
    }
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

/**
 * 把「是否在轮询」推给界面。
 *
 * 以前只有界面自己的按钮会改这个状态：从托盘点「开始/停止」时，窗口里的按钮还停在
 * 旧状态（显示「▶ 开始」但其实已经在跑），停止也不落盘 —— 重启后又自己跑起来。
 */
function pushMonitoringState(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('monitor:state', { monitoring: monitorEngine.isEnabled() })
  }
}

/** 开始监测（界面按钮与托盘共用）：启动轮询 + 落盘 + 同步界面状态。 */
function startMonitoring(intervalMs?: number): void {
  monitorEngine.setConfig(intervalMs ? { enabled: true, intervalMs } : { enabled: true })
  updateSettings(intervalMs ? { enabled: true, intervalMs } : { enabled: true })
  bindStatusPush()
  pushMonitoringState()
}

/** 停止监测（界面按钮与托盘共用）：停轮询 + 落盘 + 同步界面状态。 */
function stopMonitoring(): void {
  monitorEngine.stopAll()
  monitorEngine.setConfig({ enabled: false })
  updateSettings({ enabled: false })
  pushMonitoringState()
}

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

  // 左键唤出主界面，右键弹菜单（Windows 上 setContextMenu 会把左键也变成菜单）
  tray.on('click', () => showMainWindow())
  // 菜单每次弹出时重建：开始/停止的可用状态要跟 monitorEngine 的实际状态一致，
  // 静态菜单在托盘点完开始后还显示「开始监测」可点，与实际相反。
  tray.on('right-click', () => tray?.popUpContextMenu(buildTrayMenu()))
  tray.on('double-click', () => showMainWindow())
}

function buildTrayMenu(): Menu {
  const running = monitorEngine.isEnabled()
  return Menu.buildFromTemplate([
    {
      label: '打开主界面',
      click: () => showMainWindow(),
    },
    { type: 'separator' },
    {
      label: '开始监测',
      enabled: !running,
      click: () => startMonitoring(getSettings().intervalMs),
    },
    {
      label: '停止监测',
      enabled: running,
      click: () => stopMonitoring(),
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
}

// ===== 状态快照 CSV 导出 =====

function csvEscape(v: unknown): string {
  const s = v == null ? '' : String(v)
  // CSV 公式注入：Excel/WPS 会把 =、+、-、@、Tab 开头的单元格当公式执行（厂商名、
  // 密钥备注、上游返回的错误文本都可能以这些字符开头）。前置单引号强制按文本处理。
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

/**
 * 去掉 JSONC 注释（// 行注释、/* *\/ 块注释），但跳过字符串内部的 `//`
 * （例如 "baseURL": "https://…" 里的双斜杠）。
 */
function stripJsonComments(input: string): string {
  let out = ''
  let inStr = false
  let inLine = false
  let inBlock = false
  let esc = false
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    const n = input[i + 1]
    if (inLine) {
      if (c === '\n') {
        inLine = false
        out += c
      }
      continue
    }
    if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false
        i++
      }
      continue
    }
    if (inStr) {
      out += c
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      continue
    }
    if (c === '/' && n === '/') {
      inLine = true
      i++
      continue
    }
    if (c === '/' && n === '*') {
      inBlock = true
      i++
      continue
    }
    out += c
  }
  return out
}

/**
 * 改别人的配置文件前先留一份原始备份（只留第一次的那份，不会被后续导出覆盖）。
 * 导出的写入是整文件重写，注释/排版会丢；有 .llm-monitor.bak 至少能还原。
 */
function backupConfigOnce(targetPath: string): void {
  try {
    if (!existsSync(targetPath)) return
    const bak = `${targetPath}.llm-monitor.bak`
    if (!existsSync(bak)) copyFileSync(targetPath, bak)
  } catch {
    // 备份失败不阻断导出
  }
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
  // 和状态快照一样加 BOM：否则 Excel 双击打开，中文列头与厂商名全是乱码
  writeFileSync(result.filePath, '\uFEFF' + buildReportCsv(days ?? 30, currency), 'utf-8')
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
  // 统一走 startMonitoring：同时落盘 settings.enabled 并同步托盘/界面状态。
  startMonitoring(intervalMs)
  return true
})

ipcMain.handle('monitor:stop', () => {
  stopMonitoring()
  return true
})

ipcMain.handle('monitor:checkNow', (_event, providerId: string, keyIndex?: number) => {
  monitorEngine.checkProvider(providerId, keyIndex)
  return true
})

/**
 * 把用户填的 baseUrl 规范成可比较的形式（去尾斜杠 + 小写）。
 * 导入清单里经常一个写 `https://api.deepseek.com`、另一个写 `https://api.deepseek.com/v1/`。
 */
function normalizeBaseUrl(raw: string): string {
  return (raw || '').trim().replace(/\/+$/, '').toLowerCase()
}

/** 按 baseUrl 找供应商：完全相等 / 互为前缀（补没补 /v1 都能认）。 */
function matchProviderByBaseUrl(baseUrl: string) {
  const norm = normalizeBaseUrl(baseUrl)
  if (!norm) return undefined
  return [...PROVIDERS, ...getCustomProviders()].find((p) => {
    const pb = normalizeBaseUrl(p.baseUrl)
    if (!pb) return false
    return norm === pb || norm.startsWith(`${pb}/`) || pb.startsWith(`${norm}/`)
  })
}

/** 用域名生成一个稳定的自定义供应商 id，例如 custom-relay-example-com。 */
function providerIdFromBaseUrl(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return `custom-${host.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`
  } catch {
    return `custom-${Date.now()}`
  }
}

// 文件导入：把「baseUrl + key」落到真正存在的供应商上。
//
// 以前这里只做映射（匹配不上内置厂商就写死 providerId 'custom'），既不创建供应商
// 也不落盘 —— 中转站 / 自建网关的密钥全部堆进一个不存在的 'custom' 桶：界面看不到、
// 也不会被探测，消息却还说「成功导入 N 个密钥」。现在：能匹配内置厂商就归内置；
// 匹配不上但 baseUrl 合法，就自动建一个自定义供应商（域名作名字），并注册进引擎。
ipcMain.handle(
  'monitor:importCustom',
  (
    _event,
    customEntries: Array<{ baseUrl: string; key: string; providerId?: string }>
  ): { imported: number; createdIds: string[]; results: Array<{ providerId: string; key: string; created: boolean }> } => {
    const keysMap = getApiKeys()
    const results: Array<{ providerId: string; key: string; created: boolean }> = []
    const createdIds: string[] = []

    for (const entry of customEntries || []) {
      const key = String(entry?.key ?? '').trim()
      const baseUrl = String(entry?.baseUrl ?? '').trim()
      if (!key) continue

      // ① 渲染层已经认出厂商时直接用它
      let providerId =
        entry?.providerId && [...PROVIDERS, ...getCustomProviders()].some((p) => p.id === entry.providerId)
          ? entry.providerId
          : ''
      // ② 按 baseUrl 匹配内置 / 已有自定义供应商
      if (!providerId && baseUrl) providerId = matchProviderByBaseUrl(baseUrl)?.id ?? ''

      let created = false
      // ③ 还是没匹配上：只有 baseUrl 是合法 http(s) 才自动建供应商
      if (!providerId) {
        if (!/^https?:\/\//i.test(baseUrl)) continue
        const sameBase = getCustomProviders().find(
          (p) => normalizeBaseUrl(p.baseUrl) === normalizeBaseUrl(baseUrl)
        )
        if (sameBase) {
          providerId = sameBase.id
        } else {
          const taken = new Set([...PROVIDERS, ...getCustomProviders()].map((p) => p.id))
          const base = providerIdFromBaseUrl(baseUrl)
          let id = base
          let n = 2
          while (taken.has(id)) id = `${base}-${n++}`
          let hostName = baseUrl
          try {
            hostName = new URL(baseUrl).hostname
          } catch {
            /* 保持原样 */
          }
          const provider = addCustomProvider({
            id,
            name: hostName,
            company: '自定义',
            baseUrl,
            models: ['gpt-4o-mini'],
            protocol: 'openai',
            category: 'custom',
            note: '文件导入时自动创建',
          })
          monitorEngine.registerProviders([provider])
          createdIds.push(provider.id)
          providerId = provider.id
          created = true
        }
      }

      const list = keysMap[providerId] ? [...keysMap[providerId]] : []
      if (list.includes(key)) continue
      list.push(key)
      keysMap[providerId] = list
      results.push({ providerId, key, created })
    }

    if (results.length > 0) {
      setApiKeys(keysMap)
      for (const pid of new Set(results.map((r) => r.providerId))) {
        const list = keysMap[pid]
        const added = list
          .map((k, i) => (results.some((r) => r.providerId === pid && r.key === k) ? i : -1))
          .filter((i) => i >= 0)
        monitorEngine.setKeys(pid, list, added)
      }
      // 新建了自定义供应商 → 让渲染层重新拉一次供应商列表，卡片才会出现
      mainWindow?.webContents.send('providers:changed', createdIds)
    }

    return { imported: results.length, createdIds, results }
  }
)


ipcMain.handle('monitor:detectKey', async (_event, key: string) => {
  return monitorEngine.detectKey(key)
})

ipcMain.handle('monitor:mimoConnect', async (_event, keySuffix?: string) => {
  // 按卡片传进来的密钥尾号（后 6 位）登录它所属的小米账号：一个账号一条会话，
  // 想连 7001 的账号就点 7001 的按钮，不会再被自动登回上一个账号。
  const result = await openMimoLoginWindow(mainWindow, { keySuffix })
  if (result.ok) {
    // 只刷余额，不做探测 —— 探测要花 token，余额接口免费。
    await monitorEngine.refreshBalances('mimo')
  }
  return result
})

// ===== 阿里云百炼免费额度（只能在控制台里查，所以要走一次登录） =====

ipcMain.handle('bailian:getQuota', async (_event, force?: boolean) => getFreeQuota(!!force))

ipcMain.handle('bailian:login', async () => {
  const result = await openBailianLogin(mainWindow)
  return result
})

ipcMain.handle('bailian:logout', async () => {
  await logoutBailian()
  return { ok: true }
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

/** 探测各 Agent 的安装情况与配置文件位置，供「导出到 Agent」展示。 */
ipcMain.handle('app:detectAgentConfigs', () => detectAgentTargets())

/** 预演：返回「如果现在写入，这些文件会变成什么样」，供界面展示与确认。 */
ipcMain.handle('app:previewAgentConfig', (_event, opts: AgentExportOptions) =>
  planAgentExport(opts)
)

/** 写入 Agent 配置：先备份、再写、最后回读校验。 */
ipcMain.handle('app:writeAgentConfig', (_event, opts: AgentExportOptions) => applyAgentExport(opts))

app.whenReady().then(() => {
  // 已经有一个实例在跑：本进程直接退出，不建窗口/托盘/监测
  if (!isPrimaryInstance) return
  // 老版本只有一条全局 MiMo cookie：升级后迁成「按账号」的会话，别让用户重登。
  migrateMimoSessions()
  // 账本立刻迁到独立的 gzip 文件：老配置里那三坨大数组（余额/用量/探测流水）
  // 会被一次性搬走，主配置从几百 KB 回到几 KB，用户下次看配置也不会被流水刷屏。
  syncFlushSamples()
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
    // 走统一入口：setConfig 内部已 stopAll + startAll（重复调用 startAll 是
    // "一打开软件就弹两个提示"的来源之一）；同时把 settings.enabled 落盘，
    // 界面/托盘读到的状态才和实际一致。
    startMonitoring(settings.intervalMs)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  isQuitting = true
  // 采样是攒 500ms 合批落盘的，退出前同步刷一次，别丢掉最后几秒的账。
  try {
    syncFlushSamples()
  } catch (err) {
    console.error('[store] flush before quit failed:', err)
  }
})

app.on('window-all-closed', () => {
  monitorEngine.stopAll()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
