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

type SectionId = 'general' | 'appearance' | 'monitor' | 'latency' | 'help' | 'about'

const SECTIONS: Array<{ id: SectionId; label: string; icon: string }> = [
  { id: 'general', label: '通用', icon: '☰' },
  { id: 'appearance', label: '外观', icon: '◐' },
  { id: 'monitor', label: '监控', icon: '◉' },
  { id: 'latency', label: '测延迟', icon: '⚡' },
  { id: 'help', label: '使用说明', icon: '📖' },
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

const INTERVAL_PRESETS = [5000, 10000, 30000, 60000, 300000, 1800000]

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
  const [exporting, setExporting] = useState(false)
  const [exportMsg, setExportMsg] = useState('')
  const [extra, setExtra] = useState({
    alertsEnabled: true,
    alertSound: true,
    alertOnRecovery: true,
    minimizeToTray: true,
  })
  const [customPick, setCustomPick] = useState(false)
  const [customSec, setCustomSec] = useState(10)
  const isPreset = INTERVAL_PRESETS.includes(intervalMs)
  const showCustom = customPick || !isPreset

  useEffect(() => {
    window.electronAPI.getVersion().then(setVersion).catch(() => setVersion(''))
    window.electronAPI
      .getSettings()
      .then((s) =>
        setExtra({
          alertsEnabled: s.alertsEnabled ?? true,
          alertSound: s.alertSound ?? true,
          alertOnRecovery: s.alertOnRecovery ?? true,
          minimizeToTray: s.minimizeToTray ?? true,
        })
      )
      .catch(() => {})
  }, [])

  const patchExtra = (u: Partial<typeof extra>) => {
    setExtra((p) => ({ ...p, ...u }))
    void window.electronAPI.updateSettings(u)
  }

  const handleExportCsv = async () => {
    setExporting(true)
    setExportMsg('')
    try {
      const r = await window.electronAPI.exportStatusCsv()
      setExportMsg(r.ok ? `已保存：${r.path}` : '已取消')
    } catch {
      setExportMsg('导出失败')
    } finally {
      setExporting(false)
    }
  }

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

              <h2 className="settings-section-title">后台运行</h2>
              <div className="settings-card">
                <Row label="关闭窗口时最小化到托盘" hint="监测继续运行，托盘图标一键唤出">
                  <Toggle
                    checked={extra.minimizeToTray}
                    onChange={(v) => patchExtra({ minimizeToTray: v })}
                    label="最小化到托盘"
                  />
                </Row>
              </div>

              <h2 className="settings-section-title">数据</h2>
              <div className="settings-card">
                <Row label="导出状态快照" hint="所有密钥状态存为 CSV（Excel 可直接打开）">
                  <div className="set-inline">
                    <button className="btn btn-start" onClick={handleExportCsv} disabled={exporting}>
                      {exporting ? '导出中…' : '导出 CSV'}
                    </button>
                    {exportMsg && <span className="set-muted">{exportMsg}</span>}
                  </div>
                </Row>
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
                <Row
                  label="检测间隔"
                  hint="所有密钥按此间隔自动探测；按 token 计费的厂商（如月之暗面）建议 5 分钟以上更省"
                >
                  <div className="interval-custom">
                    <select
                      className="interval-select"
                      value={showCustom ? -1 : intervalMs}
                      onChange={(e) => {
                        const v = Number(e.target.value)
                        if (v === -1) {
                          setCustomPick(true)
                          setCustomSec(Math.max(1, Math.round(intervalMs / 1000)))
                          return
                        }
                        setCustomPick(false)
                        onIntervalChange(v)
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
                          value={customPick ? (customSec === 0 ? '' : customSec) : Math.round(intervalMs / 1000)}
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
                            if (sec >= 1 && sec <= 86400) onIntervalChange(sec * 1000)
                          }}
                        />
                        <span className="set-muted">秒</span>
                      </>
                    )}
                  </div>
                </Row>
                <Row label="探测内容" hint="延迟 · 认证 · 余额（有接口时）">
                  <span className="set-muted">自动</span>
                </Row>
              </div>

              <h2 className="settings-section-title">告警通知</h2>
              <div className="settings-card">
                <Row label="掉线 / 余额不足时通知" hint="连续多次探测失败才告警，排除正常波动">
                  <Toggle
                    checked={extra.alertsEnabled}
                    onChange={(v) => patchExtra({ alertsEnabled: v })}
                    label="异常通知"
                  />
                </Row>
                <Row label="恢复时也通知">
                  <Toggle
                    checked={extra.alertOnRecovery}
                    onChange={(v) => patchExtra({ alertOnRecovery: v })}
                    label="恢复通知"
                  />
                </Row>
                <Row label="提示音">
                  <Toggle
                    checked={extra.alertSound}
                    onChange={(v) => patchExtra({ alertSound: v })}
                    label="提示音"
                  />
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

          {section === 'help' && (
            <div className="guide">
              {/* GUIDE_BODY */}
              <h2 className="settings-section-title">快速上手（三步）</h2>
              <div className="settings-card">
                <div className="guide-step">
                  <span className="guide-step-num">1</span>
                  <div>
                    <b>导入密钥</b>
                    <p>
                      打开顶部「密钥管理」，把你的 API 密钥粘贴进去（支持一次贴多个，一行一个）。
                      软件会自动实测识别每个密钥属于哪家厂商，也可以给密钥起个备注名。
                    </p>
                  </div>
                </div>
                <div className="guide-step">
                  <span className="guide-step-num">2</span>
                  <div>
                    <b>开始监测</b>
                    <p>
                      回到「仪表盘点 ▶ 开始」，软件就按设定间隔自动探测每个密钥的可用性、延迟和余额。
                      在设置里打开"打开软件自动开启监测"，以后开机就不用再手动点了。
                    </p>
                  </div>
                </div>
                <div className="guide-step">
                  <span className="guide-step-num">3</span>
                  <div>
                    <b>看状态、等通知</b>
                    <p>
                      仪表盘每个小卡片代表一个密钥：圆点是状态（绿=在线、红=异常、灰=未检测），
                      数字是延迟，小曲线是最近 30 次的延迟走势。有密钥掉线或余额不足时，
                      右下角会弹系统通知提醒你，不用一直盯着窗口。
                    </p>
                  </div>
                </div>
              </div>

              <h2 className="settings-section-title">界面说明</h2>
              <div className="settings-card">
                <div className="guide-item">
                  <b>仪表盘</b>
                  <p>所有密钥的状态一览。鼠标悬停在卡片上可以看到错误原因、认证状态和余额详情。</p>
                </div>
                <div className="guide-item">
                  <b>密钥管理</b>
                  <p>
                    增删密钥、改备注名、复制完整密钥；点卡片上的 ⇪ 还能把密钥一键写入
                    Claude Code、Cursor、Codex 等 20 多种 Agent 工具的配置。
                  </p>
                </div>
                <div className="guide-item">
                  <b>供应商</b>
                  <p>查看内置的 20 家厂商，或添加自定义供应商（支持 OpenAI 兼容 / Anthropic / Gemini 三种协议）。</p>
                </div>
                <div className="guide-item">
                  <b>测延迟</b>
                  <p>单独对某个密钥做一次真实请求，测出首字延迟和总耗时，适合两家之间横向对比。</p>
                </div>
                <div className="guide-item">
                  <b>系统托盘</b>
                  <p>
                    关闭窗口默认缩到右下角托盘继续监测（可在「通用 → 后台运行」关闭）；
                    托盘图标左键点开主界面，右键有开始 / 停止 / 退出菜单。
                  </p>
                </div>
                <div className="guide-item">
                  <b>导出快照</b>
                  <p>「通用 → 导出状态快照」把所有密钥的状态、延迟、余额存成 CSV 表格，Excel 直接打开。</p>
                </div>
              </div>

              <h2 className="settings-section-title">常见问题</h2>
              <div className="settings-card">
                <div className="guide-item">
                  <b>密钥填在哪里？怎么一次填多个？</b>
                  <p>「密钥管理」页把密钥一行一个粘贴进输入框即可批量导入；点「测试」可先验证单个密钥能不能用。</p>
                </div>
                <div className="guide-item">
                  <b>密钥多了会不会检测很慢？</b>
                  <p>每轮最多同时检测 5 个，多出来的排队等下一轮；同一个供应商不会被重复排进队列。</p>
                </div>
                <div className="guide-item">
                  <b>为什么显示「离线」，但我觉得它还能用？</b>
                  <p>为了减少误报，连续 3 次失败才会判定为离线；网络抖动一下不会马上变红。</p>
                </div>
                <div className="guide-item">
                  <b>通知弹不出来？</b>
                  <p>检查 Windows 的「专注助手 / 通知设置」是否拦截了应用通知；通知开关在本页「监测 → 告警通知」。</p>
                </div>
                <div className="guide-item">
                  <b>关了窗口程序就停了吗？</b>
                  <p>不会。默认缩到右下角托盘继续监测；想真正退出用托盘右键「退出」，或在「通用 → 后台运行」关闭该行为。</p>
                </div>
                <div className="guide-item">
                  <b>配置存在哪里？换电脑怎么迁移？</b>
                  <p>配置文件路径见本页「通用 → 数据」；把该文件拷到新电脑的相同位置即可迁移密钥和设置。</p>
                </div>
              </div>
            </div>
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
