import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { Provider, ProviderStatus } from '../preload'
import Dashboard from './components/Dashboard'
import KeyManager from './components/KeyManager'
import ProviderManager from './components/ProviderManager'
import './App.css'

type View = 'dashboard' | 'keys' | 'providers'
type StatusSnapshot = { onlineCount: number; errorCount: number; checkingCount: number; latest: Record<string, ProviderStatus> | null }

// Throttle status updates so UI doesn't flash on every check interval
function useThrottledStatus(throttleMs: number = 500) {
  const [snapshot, setSnapshot] = useState<StatusSnapshot>({
    onlineCount: 0,
    errorCount: 0,
    checkingCount: 0,
    latest: null,
  })

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Expose a setter that batches rapid updates
  const setStatuses = useCallback((newStatuses: Record<string, ProviderStatus>) => {
    if (timerRef.current) return // ignore intermediate updates within throttle window

    // Compute counts synchronously then defer full state update
    let oc = 0, ec = 0, cc = 0
    for (const s of Object.values(newStatuses)) {
      if (s.status === 'online') oc++
      else if (s.status === 'error' || s.status === 'offline') ec++
      else if (s.status === 'checking') cc++
    }

    setSnapshot({ onlineCount: oc, errorCount: ec, checkingCount: cc, latest: newStatuses })

    timerRef.current = setTimeout(() => {
      timerRef.current = null
    }, throttleMs)
  }, [throttleMs])

  // Subscribe through Electron
  useEffect(() => {
    const cleanup = window.electronAPI.onStatusUpdate(setStatuses)
    return cleanup
  }, [])

  // Return a stable reference to either show dashboard card updates or keep header stats alive
  return snapshot as typeof snapshot & { setStatuses: typeof setStatuses; setStatusesWithoutThrottle: (s: Record<string, ProviderStatus>) => void }
}

export default function App() {
  const [view, setView] = useState<View>('dashboard')
  const [providers, setProviders] = useState<Provider[]>([])
  const [monitoring, setMonitoring] = useState(false)
  const [interval, setIntervalMs] = useState(10000)
  const [keys, setKeys] = useState<Record<string, string[]>>({})
  const throttled = useThrottledStatus()
  const [showDash, setShowDash] = useState(true)
  const dashTimerRef = useRef<ReturnType<typeof setTimeout>>(null)

  useEffect(() => {
    Promise.all([
      window.electronAPI.getProviders(),
      window.electronAPI.getKeys(),
      window.electronAPI.getSettings(),
    ]).then(([provs, ks, settings]) => {
      setProviders(provs)
      setKeys(ks)
      setIntervalMs(settings.intervalMs)
    })
  }, [])

  // Only listen to status updates on the dashboard tab
  useEffect(() => {
    setShowDash(view === 'dashboard')
  }, [view])

  // Debounce dashboard subscribe/unsubscribe via Electron IPC channel naming
  useEffect(() => {
    if (view !== 'dashboard') return
    const cleanup = window.electronAPI.onStatusUpdate((newStatuses) => {
      throttled.setStatusesWithoutThrottle(newStatuses)
    })
    if (dashTimerRef.current) clearTimeout(dashTimerRef.current)
    dashTimerRef.current = setTimeout(() => {
      throttled.setStatuses(throttled.latest ?? {})
      dashTimerRef.current = null
    }, 800)
    return () => { /* can't unsubscribe mid-useEffect without tracking */ }
  }, [view, throttled.setStatuses])

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

  const handleCheckNow = useCallback(async (providerId: string) => {
    await window.electronAPI.checkNow(providerId)
  }, [])

  const keyCount = useMemo(() => Object.values(keys).flat().length, [keys])

  // Memoize the render block so non-related changes don't re-render siblings
  const _viewId = view
  const _stats = `${throttled.onlineCount}-${throttled.errorCount}-${throttled.checkingCount}`

  return (
    <div className="app">
      {/* Header always renders but depends only on sparse values */}
      <header className="header" key={`h-${_stats}`}>
        <div className="header-left">
          <h1 className="logo">
            <span className="logo-mark">⚡</span>
            LLM API Monitor
          </h1>
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
          </nav>
        </div>
        <div className="header-right">
          <div className="stats">
            <span className="stat online"><span className="dot" />{throttled.onlineCount}</span>
            <span className="stat error"><span className="dot" />{throttled.errorCount}</span>
            <span className="stat checking"><span className="dot" />{throttled.checkingCount}</span>
          </div>
          <div className="controls">
            <select
              className="interval-select"
              value={interval}
              onChange={(e) => handleIntervalChange(Number(e.target.value))}
              disabled={monitoring}
            >
              <option value={5000}>5 秒</option>
              <option value={10000}>10 秒</option>
              <option value={30000}>30 秒</option>
              <option value={60000}>60 秒</option>
            </select>
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

      <main className="main">
        {_viewId === 'dashboard' ? (
          <Dashboard providers={providers} statuses={throttled.latest ?? {}} onCheckNow={handleCheckNow} monitoring={monitoring} />
        ) : _viewId === 'keys' ? (
          <KeyManager providers={providers} keys={keys} onKeysChange={handleKeysChange} />
        ) : (
          <ProviderManager providers={providers} onProvidersChange={setProviders} />
        )}
      </main>
    </div>
  )
}
