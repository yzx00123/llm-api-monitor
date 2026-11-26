import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Provider } from '../preload'
import type {
  AgentExportOptions,
  AgentPlan,
  AgentTargetId,
  AgentTargetInfo,
} from '../../../preload'

interface Props {
  provider: Provider
  apiKey: string
  /** full key -> custom display name */
  label?: string
  onClose: () => void
}

type Notice = { kind: 'ok' | 'err' | 'info'; text: string }

/**
 * 「导出到 Agent」面板。
 *
 * 这里刻意不做「一键全写」：每个 Agent 的配置文件格式都不一样，写错会弄坏用户
 * 已经在用的配置，所以流程是——选目标 → 看预演（真实文件内容）→ 确认写入 → 回读
 * 校验。安装检测也只认命令行 / 安装目录这类硬证据，不再用「配置文件存在」冒充
 * 「装过」（旧版就是这么把 Claude Code、OpenClaw 误报成已安装的）。
 */
export default function AgentExportModal({ provider, apiKey, label, onClose }: Props) {
  const [targets, setTargets] = useState<AgentTargetInfo[] | null>(null)
  const [detectError, setDetectError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string>('')
  const [model, setModel] = useState('')
  const [customPath, setCustomPath] = useState('')
  const [plan, setPlan] = useState<AgentPlan | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [writing, setWriting] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [copiedTag, setCopiedTag] = useState('')
  const [showAll, setShowAll] = useState(false)
  const previewSeq = useRef(0)
  const copyTimer = useRef<number | null>(null)

  const title = label || provider.name
  // 模型候选只取前 60 个：整张模型表动辄上百条，塞进 datalist 不划算。
  const modelOptions = useMemo(() => provider.models.slice(0, 60), [provider.models])

  useEffect(() => {
    setModel(provider.models[0] ?? '')
  }, [provider])

  // 安装检测只跑一次。旧版每次渲染都重新检测，是卡顿的主因之一。
  useEffect(() => {
    let alive = true
    window.electronAPI
      .detectAgentConfigs()
      .then((list) => {
        if (!alive) return
        setTargets(list)
        const first = list.find((t) => t.installed) ?? list.find((t) => t.exists) ?? list[0]
        if (first) setSelected(first.id)
      })
      .catch((err: unknown) => {
        if (alive) setDetectError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current)
    },
    []
  )

  const current = useMemo(
    () => targets?.find((t) => t.id === selected) ?? null,
    [targets, selected]
  )
  const installedTargets = useMemo(() => (targets ?? []).filter((t) => t.installed), [targets])
  const otherTargets = useMemo(() => (targets ?? []).filter((t) => !t.installed), [targets])

  const buildOptions = useCallback((): AgentExportOptions | null => {
    if (!selected) return null
    const options: AgentExportOptions = {
      target: selected as AgentTargetId,
      baseUrl: provider.baseUrl,
      apiKey,
      model: model.trim() || undefined,
      providerName: title,
      providerId: provider.id,
      providerProtocol: provider.protocol,
    }
    if (selected === 'custom') {
      const path = customPath.trim()
      if (!path) return null
      options.path = path
    }
    return options
  }, [selected, provider.baseUrl, provider.id, provider.protocol, apiKey, model, title, customPath])

  // 预演：改动后 350ms 才请求，切目标 / 打模型名时不会连打主进程。
  useEffect(() => {
    const options = buildOptions()
    if (!options) {
      setPlan(null)
      setPreviewing(false)
      return
    }
    const seq = ++previewSeq.current
    setPreviewing(true)
    const timer = window.setTimeout(() => {
      window.electronAPI
        .previewAgentConfig(options)
        .then((next) => {
          if (seq !== previewSeq.current) return
          setPlan(next)
          setPreviewing(false)
        })
        .catch((err: unknown) => {
          if (seq !== previewSeq.current) return
          setPlan(null)
          setPreviewing(false)
          setNotice({ kind: 'err', text: `预演失败：${err instanceof Error ? err.message : err}` })
        })
    }, 350)
    return () => window.clearTimeout(timer)
  }, [buildOptions])

  const flash = (kind: Notice['kind'], text: string) => setNotice({ kind, text })

  const copy = async (text: string, tag: string) => {
    const ok = await window.electronAPI.copyText(text)
    setCopiedTag(ok ? tag : '')
    if (copyTimer.current) window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopiedTag(''), 1600)
  }

  const copyConfig = () => {
    if (!plan || plan.files.length === 0) return
    const text = plan.files
      .map((f) => (plan.files.length > 1 ? `# ${f.path}\n${f.content}` : f.content))
      .join('\n\n')
    void copy(text, 'config')
  }

  const saveAs = async () => {
    if (!plan) return
    const content =
      plan.files.length > 1
        ? plan.files.map((f) => `# ${f.path}\n${f.content}`).join('\n\n')
        : (plan.files[0]?.content ?? '')
    const language = plan.files[0]?.language ?? 'text'
    const ext = language === 'env' ? 'sh' : language === 'text' ? 'txt' : language
    const res = await window.electronAPI.saveTextFile({
      defaultName: `${plan.target}-config.${ext}`.replace(/\s+/g, '-'),
      content,
    })
    if (res.ok) flash('ok', `已保存到 ${res.path}`)
  }

  const write = async () => {
    const options = buildOptions()
    if (!options || !plan) return
    setWriting(true)
    setNotice(null)
    try {
      const res = await window.electronAPI.writeAgentConfig(options)
      if (res.ok) flash('ok', `已写入：${res.files.join('、')}（已回读校验）`)
      else flash('err', res.error || '写入失败')
    } catch (err) {
      flash('err', `写入失败：${err instanceof Error ? err.message : err}`)
    } finally {
      setWriting(false)
    }
  }

  const renderTarget = (t: AgentTargetInfo) => (
    <button
      key={t.id}
      type="button"
      className={`agent-target${selected === t.id ? ' active' : ''}`}
      onClick={() => {
        setSelected(t.id)
        setNotice(null)
      }}
      title={t.evidence ? `安装证据：${t.evidence}` : t.path}
    >
      <span className="agent-target-top">
        <span className="agent-target-name">{t.label}</span>
        {t.installed && <span className="agent-target-tag ok">已安装</span>}
        {t.confidence === 'guessed' && (
          <span className="agent-target-tag warn" title="这个路径/字段是按厂商习惯推测的，产品是否读取未经验证">
            未验证
          </span>
        )}
      </span>
      <span className="agent-target-hint">{t.evidence ?? t.writes}</span>
    </button>
  )

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-large modal-agent" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h3>导出到 Agent</h3>
            <span className="agent-key-label">
              {title} · {provider.baseUrl}
            </span>
          </div>
          <button className="modal-close" onClick={onClose} title="关闭（Esc）">
            ✕
          </button>
        </div>

        <div className="modal-body">
          <section className="agent-section">
            <h4 className="agent-section-title">选择目标</h4>
            {detectError && <p className="agent-error">检测失败：{detectError}</p>}
            {!targets && !detectError && <p className="agent-muted">正在检测已安装的 Agent…</p>}
            {targets && (
              <>
                {installedTargets.length > 0 ? (
                  <div className="agent-target-list">{installedTargets.map(renderTarget)}</div>
                ) : (
                  <p className="agent-muted">
                    没有检测到已安装的 Agent（只认命令行和安装目录，残留的配置文件不算）。
                  </p>
                )}
                <div className="agent-target-list agent-target-list-more">
                  {showAll ? (
                    otherTargets.map(renderTarget)
                  ) : (
                    <button
                      type="button"
                      className="agent-target agent-target-more"
                      onClick={() => setShowAll(true)}
                    >
                      <span className="agent-target-top">
                        <span className="agent-target-name">
                          未检测到的 Agent（{otherTargets.length}）
                        </span>
                      </span>
                      <span className="agent-target-hint">点开仍然可以手动写入</span>
                    </button>
                  )}
                </div>
              </>
            )}
          </section>

          <section className="agent-section">
            <h4 className="agent-section-title">配置</h4>
            {current?.note && <p className="agent-muted">{current.note}</p>}
            {selected === 'custom' && (
              <label className="agent-field">
                <span>配置文件路径</span>
                <input
                  type="text"
                  value={customPath}
                  onChange={(e) => setCustomPath(e.target.value)}
                  placeholder="C:\Users\you\.myagent\config.json"
                  spellCheck={false}
                />
              </label>
            )}
            <label className="agent-field">
              <span>模型（可选）</span>
              <input
                type="text"
                list="agent-model-options"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={provider.models[0] ?? '例如 gpt-4o-mini'}
                spellCheck={false}
              />
              <datalist id="agent-model-options">
                {modelOptions.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </label>
            <p className="agent-muted">
              写入位置：{current ? current.writes : '—'}
              {current?.path ? `　路径：${current.path}` : ''}
            </p>
          </section>

          <section className="agent-section">
            <h4 className="agent-section-title">
              预演{previewing ? '（生成中…）' : ''}
              {plan?.manual && <span className="agent-target-tag">只能复制</span>}
            </h4>
            {!plan && (
              <p className="agent-muted">选好目标后，这里会显示写入之后的完整文件内容。</p>
            )}
            {plan && !plan.ok && <p className="agent-error">{plan.error}</p>}
            {plan?.files.map((file) => (
              <div className="agent-preview-block" key={file.path}>
                <div className="agent-preview-head">{file.path}</div>
                <pre className="agent-preview">{file.content}</pre>
              </div>
            ))}
            {plan?.manual && (
              <p className="agent-muted">这个 Agent 没有能安全改写的配置文件，请复制上面的内容自行粘贴。</p>
            )}
          </section>
        </div>

        {/* 结果提示放在滚动区之外，写完不用再往上翻才能看到 */}
        {notice && <p className={`agent-notice ${notice.kind}`}>{notice.text}</p>}

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={copyConfig} disabled={!plan?.ok}>
            {copiedTag === 'config' ? '已复制配置' : '复制配置'}
          </button>
          <button className="btn btn-secondary" onClick={() => void copy(apiKey, 'key')}>
            {copiedTag === 'key' ? '已复制密钥' : '复制密钥'}
          </button>
          <button className="btn btn-secondary" onClick={() => void saveAs()} disabled={!plan?.ok}>
            另存为文件
          </button>
          <button
            className="btn btn-start"
            onClick={() => void write()}
            disabled={!plan?.ok || plan.manual || writing}
            title={plan?.manual ? '这个目标只能复制内容，不能直接写入' : '写入并回读校验'}
          >
            {writing ? '写入中…' : '写入配置'}
          </button>
        </div>
      </div>
    </div>
  )
}
