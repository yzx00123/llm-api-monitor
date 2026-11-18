import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { Provider, ProviderStatus } from '../preload'
import Dashboard from './components/Dashboard'
import KeyManager from './components/KeyManager'
import ProviderManager from './components/ProviderManager'
import Settings from './components/Settings'
import './App.css'

type View = 'dashboard' | 'keys' | 'providers' | 'settings'
type ThemeMode = 'light' | 'dark' | 'system'
type StatusSnapshot = { onlineCount: number; errorCount: number; checkingCount: number; latest: Record<string, ProviderStatus> | null }

/** Resolve theme mode against the OS setting and apply to <html data-theme>. */
function applyTheme(mode: ThemeMode) {
  const resolved = mode === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : mode
  document.documentElement.dataset['theme'] = resolved
}

// Trailing-edge throttle for status updates. Leading-edge dropped the LAST
// update in a burst (card could stay on "checking" until the next poll).
function useThrottledStatus(throttleMs: number = 300) {
  const [snapshot, setSnapshot] = useState<StatusSnapshot>({
    onlineCount: 0,
    errorCount: 0,
    checkingCount: 0,
    latest: null,
  })

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRef = useRef<Record<string, ProviderStatus> | null>(null)

  const flush = useCallback(() => {
    timerRef.current = null
    const newStatuses = pendingRef.current
    pendingRef.current = null
    if (!newStatuses) return

    let oc = 0, ec = 0, cc = 0
    for (const s of Object.values(newStatuses)) {
      if (s.status === 'online') oc++
      else if (s.status === 'error' || s.status === 'offline') ec++
      else if (s.status === 'checking') cc++
    }
    setSnapshot({ onlineCount: oc, errorCount: ec, checkingCount: cc, latest: newStatuses })
  }, [])

  const setStatuses = useCallback(
    (newStatuses: Record<string, ProviderStatus>) => {
      pendingRef.current = newStatuses
      if (timerRef.current) return
      timerRef.current = setTimeout(flush, throttleMs)
    },
    [flush, throttleMs]
  )

  // Subscribe through Electron
  useEffect(() => {
    const cleanup = window.electronAPI.onStatusUpdate(setStatuses)
    return cleanup
  }, [setStatuses])

  // Flush on unmount so the last snapshot isn't lost
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        flush()
      }
    }
  }, [flush])

  return snapshot as typeof snapshot & { setStatuses: typeof setStatuses; setStatusesWithoutThrottle: (s: Record<string, ProviderStatus>) => void }
}

/** Stable empty object — a fresh `{}` every render breaks memoized children. */
const EMPTY_STATUS: Record<string, ProviderStatus> = {}

const INTERVAL_PRESETS = [5000, 10000, 30000, 60000, 300000, 1800000]

export default function App() {
  const [view, setView] = useState<View>('dashboard')
  const [providers, setProviders] = useState<Provider[]>([])
  const [monitoring, setMonitoring] = useState(false)
  const [interval, setIntervalMs] = useState(10000)
  const [keys, setKeys] = useState<Record<string, string[]>>({})
  const [keyLabels, setKeyLabels] = useState<Record<string, string>>({})
  const throttled = useThrottledStatus()
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [autoStart, setAutoStart] = useState(true)
  const [theme, setTheme] = useState<ThemeMode>('system')
  const [customPick, setCustomPick] = useState(false)
  const [customSec, setCustomSec] = useState(10)
  const isPreset = INTERVAL_PRESETS.includes(interval)
  const showCustom = customPick || !isPreset

  useEffect(() => {
    Promise.all([
      window.electronAPI.getProviders(),
      window.electronAPI.getKeys(),
      window.electronAPI.getKeyLabels(),
      window.electronAPI.getSettings(),
    ]).then(([provs, ks, labels, settings]) => {
      setProviders(provs)
      setKeys(ks)
      setKeyLabels(labels)
      setIntervalMs(settings.intervalMs)
      setAutoStart((settings as { autoStart?: boolean }).autoStart ?? true)
      const t = ((settings as { theme?: ThemeMode }).theme ?? 'system')
      setTheme(t)
      applyTheme(t)
      // Main process auto-started polling before the window opened — reflect
      // that in the header so it shows ■ 停止 instead of ▶ 开始.
      if ((settings as { autoStart?: boolean }).autoStart && Object.keys(ks).length > 0) {
        setMonitoring(true)
      }
      // First-run tutorial dialog
      if (!(settings as { onboarded?: boolean }).onboarded) {
        setShowOnboarding(true)
      }
    })
  }, [])

  // Follow OS theme while in 'system' mode
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyTheme(theme)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme])

  const handleThemeChange = useCallback((mode: ThemeMode) => {
    setTheme(mode)
    applyTheme(mode)
    window.electronAPI.updateSettings({ theme: mode } as Record<string, unknown>)
  }, [])

  const handleIntervalChange = useCallback(async (newInterval: number) => {
    await window.electronAPI.updateSettings({ intervalMs: newInterval })
    setIntervalMs(newInterval)
  }, [])

  const startMonitoring = useCallback(async () => {
    const ids = Object.keys(keys)
    if (ids.length === 0) return
    await window.electronAPI.startMonitoring(ids, interval)
    setMonitoring(true)
  }, [keys, interval])

  const stopMonitoring = useCallback(async () => {
    await window.electronAPI.stopMonitoring()
    setMonitoring(false)
  }, [])

  const handleKeysChange = useCallback(
    async (newKeys: Record<string, string[]>) => {
      await window.electronAPI.setKeys(newKeys)
      setKeys(newKeys)
    },
    []
  )

  const handleCheckNow = useCallback(async (providerId: string, keyIndex: number) => {
    await window.electronAPI.checkNow(providerId, keyIndex)
  }, [])

  const handleKeyLabelChange = useCallback(async (key: string, label: string) => {
    await window.electronAPI.setKeyLabel(key, label)
    setKeyLabels((prev) => {
      const next = { ...prev }
      if (label.trim()) next[key] = label.trim()
      else delete next[key]
      return next
    })
  }, [])

  const closeOnboarding = useCallback(
    async (gotoKeys: boolean) => {
      await window.electronAPI.updateSettings({ onboarded: true, autoStart })
      setShowOnboarding(false)
      if (gotoKeys) setView('keys')
    },
    [autoStart]
  )

  const keyCount = useMemo(() => Object.values(keys).flat().length, [keys])

  // Memoize the render block so non-related changes don't re-render siblings
  const _viewId = view

  return (
    <div className="app">
      {/* Header stays mounted — key={stats} used to tear down the whole
          subtree (and remount selects/buttons) on every status burst. */}
      <header className="header">
        <div className="header-left">
          <nav className="nav">
            <button className={`nav-btn ${view === 'dashboard' ? 'active' : ''}`} onClick={() => setView('dashboard')}>
              仪表盘
            </button>
            <button className={`nav-btn ${view === 'keys' ? 'active' : ''}`} onClick={() => setView('keys')}>
              密钥管理 {keyCount > 0 && <span className="badge">{keyCount}</span>}
            </button>
            <button className={`nav-btn ${view === 'providers' ? 'active' : ''}`} onClick={() => setView('providers')}>
              供应商
            </button>
            <button className={`nav-btn ${view === 'settings' ? 'active' : ''}`} onClick={() => setView('settings')}>
              设置
            </button>
          </nav>
        </div>
        <div className="header-right">
          <div className="stats">
            <span className="stat online"><span className="dot" />{throttled.onlineCount}</span>
            <span className="stat error"><span className="dot" />{throttled.errorCount}</span>
            <span className="stat checking"><span className="dot" />{throttled.checkingCount}</span>
          </div>
          <div className="controls">
            <div className="interval-custom">
              <select
                className="interval-select"
                value={showCustom ? -1 : interval}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  if (v === -1) {
                    setCustomPick(true)
                    setCustomSec(Math.max(1, Math.round(interval / 1000)))
                    return
                  }
                  setCustomPick(false)
                  void handleIntervalChange(v)
                }}
              >
                <option value={5000}>5 秒</option>
                <option value={10000}>10 秒</option>
                <option value={30000}>30 秒</option>
                <option value={60000}>60 秒</option>
                <option value={300000}>5 分钟</option>
                <option value={1800000}>30 分钟</option>
                <option value={-1}>自定义…</option>
              </select>
              {showCustom && (
                <>
                  <input
                    className="form-input interval-custom-input"
                    type="number"
                    min={1}
                    max={86400}
                    value={customPick ? (customSec === 0 ? '' : customSec) : Math.round(interval / 1000)}
                    onChange={(e) => {
                      const raw = e.target.value
                      if (raw === '') {
                        setCustomPick(true)
                        setCustomSec(0)
                        return
                      }
                      const sec = Math.round(Number(raw))
                      setCustomPick(true)
                      setCustomSec(sec)
                      if (sec >= 1 && sec <= 86400) void handleIntervalChange(sec * 1000)
                    }}
                    title="自定义间隔（秒）"
                  />
                  <span className="set-muted">秒</span>
                </>
              )}
            </div>
            {monitoring ? (
              <button className="btn btn-stop" onClick={stopMonitoring}>■ 停止</button>
            ) : (
              <button className="btn btn-start" onClick={startMonitoring} disabled={keyCount === 0}>
                ▶ 开始
              </button>
            )}
          </div>
        </div>
      </header>

      <main className={`main${view === 'settings' || view === 'providers' ? ' main-wide' : ''}`}>
        {_viewId === 'dashboard' ? (
          <Dashboard providers={providers} keys={keys} labels={keyLabels} statuses={throttled.latest ?? EMPTY_STATUS} onCheckNow={handleCheckNow} onLabelChange={handleKeyLabelChange} monitoring={monitoring} />
        ) : _viewId === 'keys' ? (
          <KeyManager providers={providers} keys={keys} labels={keyLabels} onKeysChange={handleKeysChange} />
        ) : _viewId === 'providers' ? (
          <ProviderManager
            providers={providers}
            onProvidersChange={setProviders}
            onBack={() => setView('dashboard')}
          />
        ) : (
          <Settings
            theme={theme}
            onThemeChange={handleThemeChange}
            intervalMs={interval}
            onIntervalChange={handleIntervalChange}
            autoStart={autoStart}
            onAutoStartChange={(v) => {
              setAutoStart(v)
              void window.electronAPI.updateSettings({ autoStart: v })
            }}
            monitoring={monitoring}
            onStart={() => void startMonitoring()}
            onStop={() => void stopMonitoring()}
            keyCount={keyCount}
            onBack={() => setView('dashboard')}
            providers={providers}
            keys={keys}
            keyLabels={keyLabels}
          />
        )}
      </main>

      {showOnboarding && (
        <div className="modal-overlay">
          <div className="modal modal-onboarding">
            <div className="modal-header">
              <h3>👋 欢迎使用 LLM API Monitor</h3>
            </div>
            <div className="modal-body">
              <p className="onboarding-lead">
                三步开始监控你的大模型 API：
              </p>
              <ol className="onboarding-steps">
                <li>
                  <strong>导入 API 密钥</strong>
                  <span>在「密钥管理」粘贴密钥，支持批量导入，自动识别厂商</span>
                </li>
                <li>
                  <strong>点击「开始」</strong>
                  <span>软件会按你选的间隔自动探测各家 API 的延迟和余额</span>
                </li>
                <li>
                  <strong>看仪表盘</strong>
                  <span>绿点 = 在线，卡片显示实时延迟与账户余额</span>
                </li>
              </ol>
              <label className="onboarding-autostart">
                <input
                  type="checkbox"
                  checked={autoStart}
                  onChange={(e) => {
                    setAutoStart(e.target.checked)
                    window.electronAPI.updateSettings({ autoStart: e.target.checked })
                  }}
                />
                以后打开软件自动开启监测
              </label>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => closeOnboarding(false)}>
                先看看界面
              </button>
              <button className="btn btn-start" onClick={() => closeOnboarding(true)}>
                去导入密钥 →
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
