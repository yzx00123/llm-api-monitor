import { useState, useEffect, useCallback } from 'react'
import type { Provider } from '../preload'
import LatencyTest from './LatencyTest'

type ThemeMode = 'light' | 'dark' | 'system'

interface Props {
  theme: ThemeMode
  onThemeChange: (mode: ThemeMode) => void
  intervalMs: number
  onIntervalChange: (ms: number) => void
  autoStart: boolean
  onAutoStartChange: (v: boolean) => void
  monitoring: boolean
  onStart: () => void
  onStop: () => void
  keyCount: number
  onBack: () => void
  providers: Provider[]
  keys: Record<string, string[]>
  keyLabels: Record<string, string>
}

type SectionId = 'general' | 'appearance' | 'monitor' | 'latency' | 'about'

const SECTIONS: Array<{ id: SectionId; label: string; icon: string }> = [
  { id: 'general', label: '通用', icon: '☰' },
  { id: 'appearance', label: '外观', icon: '◐' },
  { id: 'monitor', label: '监控', icon: '◉' },
  { id: 'latency', label: '测延迟', icon: '⚡' },
  { id: 'about', label: '关于', icon: 'ⓘ' },
]

function Row({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="set-row">
      <div className="set-row-label">
        <span>{label}</span>
        {hint && <span className="set-row-hint">{hint}</span>}
      </div>
      <div className="set-row-control">{children}</div>
    </div>
  )
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`set-toggle ${checked ? 'on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="set-toggle-knob" />
    </button>
  )
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (v: T) => void
}) {
  return (
    <div className="set-segmented">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={value === o.value ? 'active' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export default function Settings({
  theme,
  onThemeChange,
  intervalMs,
  onIntervalChange,
  autoStart,
  onAutoStartChange,
  monitoring,
  onStart,
  onStop,
  keyCount,
  onBack,
  providers,
  keys,
  keyLabels,
}: Props) {
  const [section, setSection] = useState<SectionId>('general')
  const [version, setVersion] = useState('')

  useEffect(() => {
    window.electronAPI.getVersion().then(setVersion).catch(() => setVersion(''))
  }, [])

  const handleGithub = useCallback(() => {
    window.open('https://github.com/yzx00123/llm-api-monitor', '_blank')
  }, [])

  return (
    <div className="settings-layout">
      <aside className="settings-side">
        <button className="settings-back" onClick={onBack}>
          ← 返回
        </button>
        <div className="settings-side-label">设置</div>
        <nav className="settings-nav">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              className={section === s.id ? 'active' : ''}
              onClick={() => setSection(s.id)}
            >
              <span className="settings-nav-icon">{s.icon}</span>
              {s.label}
            </button>
          ))}
        </nav>
        <div className="settings-side-foot">LLM API Monitor {version && `v${version}`}</div>
      </aside>

      <div className="settings-content">
        <header className="settings-top">
          <span className="settings-top-icon">
            {SECTIONS.find((s) => s.id === section)?.icon}
          </span>
          <h1>{SECTIONS.find((s) => s.id === section)?.label}</h1>
        </header>

        <div className="settings-body">
          {section === 'general' && (
            <>
              <h2 className="settings-section-title">启动</h2>
              <div className="settings-card">
                <Row label="打开软件自动开启监测" hint="有密钥时启动即轮询">
                  <Toggle checked={autoStart} onChange={onAutoStartChange} label="自动监测" />
                </Row>
                <Row label="监测状态">
                  <div className="set-inline">
                    <span className={`set-status-pill ${monitoring ? 'on' : 'off'}`}>
                      {monitoring ? '监测中' : '已停止'}
                    </span>
                    {monitoring ? (
                      <button className="btn btn-stop" onClick={onStop}>
                        ■ 停止
                      </button>
                    ) : (
                      <button
                        className="btn btn-start"
                        onClick={onStart}
                        disabled={keyCount === 0}
                      >
                        ▶ 开始
                      </button>
                    )}
                  </div>
                </Row>
                <Row label="已导入密钥">
                  <span className="set-muted">{keyCount} 个</span>
                </Row>
              </div>

              <h2 className="settings-section-title">数据</h2>
              <div className="settings-card">
                <Row label="配置存储位置" hint="密钥仅保存在本机">
                  <code className="set-path">%APPDATA%\Electron\llm-monitor-config.json</code>
                </Row>
              </div>
            </>
          )}

          {section === 'appearance' && (
            <>
              <h2 className="settings-section-title">外观</h2>
              <div className="settings-card">
                <Row label="明暗">
                  <Segmented
                    value={theme}
                    onChange={onThemeChange}
                    options={[
                      { value: 'system', label: '跟随系统' },
                      { value: 'light', label: '月之亮面' },
                      { value: 'dark', label: '月之暗面' },
                    ]}
                  />
                </Row>
              </div>
            </>
          )}

          {section === 'monitor' && (
            <>
              <h2 className="settings-section-title">轮询</h2>
              <div className="settings-card">
                <Row label="检测间隔" hint="所有密钥按此间隔自动探测">
                  <select
                    className="interval-select"
                    value={intervalMs}
                    onChange={(e) => onIntervalChange(Number(e.target.value))}
                  >
                    <option value={5000}>5 秒</option>
                    <option value={10000}>10 秒</option>
                    <option value={30000}>30 秒</option>
                    <option value={60000}>60 秒</option>
                  </select>
                </Row>
                <Row label="探测内容" hint="延迟 · 认证 · 余额（有接口时）">
                  <span className="set-muted">自动</span>
                </Row>
              </div>
            </>
          )}

          {section === 'latency' && (
            <LatencyTest
              providers={providers}
              keys={keys}
              keyLabels={keyLabels}
              embedded
            />
          )}

          {section === 'about' && (
            <>
              <div className="settings-card settings-about-card">
                <div className="settings-about-head">
                  <div className="settings-about-logo">⚡</div>
                  <div>
                    <div className="settings-about-name">LLM API Monitor</div>
                    <div className="settings-about-ver">版本 v{version || '…'}</div>
                  </div>
                </div>
                <div className="settings-about-actions">
                  <button className="btn-secondary set-chip" onClick={handleGithub}>
                    GitHub
                  </button>
                  <button className="btn-secondary set-chip" onClick={handleGithub}>
                    更新日志
                  </button>
                </div>
                <div className="settings-about-banner">
                  <span>⭐ 如果本工具帮到了你，欢迎在 GitHub 点个 Star</span>
                  <button className="btn-secondary set-chip" onClick={handleGithub}>
                    去点 Star
                  </button>
                </div>
              </div>
              <div className="settings-card">
                <Row label="开源协议">
                  <span className="set-muted">MIT</span>
                </Row>
                <Row label="本地运行">
                  <span className="set-muted">密钥不出本机</span>
                </Row>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
