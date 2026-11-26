import type { Provider } from '../preload'

export interface ParsedKeyEntry {
  baseUrl: string
  key: string
  providerId?: string
}

export interface ParseKeyFileResult {
  entries: ParsedKeyEntry[]
  /** 无法识别、被丢弃的条数（提示语里要如实报）。 */
  skipped: number
}

/**
 * 解析「密钥管理 → 文件导入」的文本内容（.json / .csv / .txt）。
 *
 * 这里以前有几个坑：扩展名大小写敏感（清单.CSV 静默无反应）、只支持「数组」这一种
 * JSON 形状（{ "deepseek": ["sk-1"] } 这种映射格式静默 0 条）、匹配不上厂商的条目
 * 交给主进程后被塞进不存在的 providerId 'custom'（界面看不到、也不会被探测），
 * 而提示照样说「成功导入 N 个密钥」。现在统一解析成 { providerId, baseUrl, key }
 * 交给主进程，由主进程匹配/新建供应商并真正落盘，界面按结果如实报告。
 *
 * 抽成纯函数是为了能直接跑测试（scripts/test-keyfile-import.ts）。
 */
export function parseKeyFile(text: string, ext: string, providers: Provider[]): ParseKeyFileResult {
  const entries: ParsedKeyEntry[] = []
  let skipped = 0

  const normUrl = (u: string) => (u || '').trim().replace(/\/+$/, '').toLowerCase()
  const matchProvider = (wanted: string) => {
    const w = (wanted || '').trim().toLowerCase()
    if (!w) return undefined
    return providers.find(
      (p) =>
        p.id.toLowerCase() === w ||
        p.name.toLowerCase() === w ||
        (p.baseUrl ? p.baseUrl.toLowerCase().includes(w) : false)
    )
  }

  const pushEntry = (providerId: string | undefined, baseUrl: string, key: string) => {
    const k = (key || '').trim()
    if (!baseUrl || !k) {
      skipped += 1
      return
    }
    entries.push({ baseUrl, key: k, providerId })
  }

  if (ext === 'json') {
    const data = JSON.parse(text) as unknown
    const items: Array<Record<string, unknown>> = []
    if (Array.isArray(data)) {
      for (const one of data) {
        if (one && typeof one === 'object') items.push(one as Record<string, unknown>)
      }
    } else if (data && typeof data === 'object') {
      const obj = data as Record<string, unknown>
      // 先认「单条记录」：{ provider, baseUrl, key } 这种写法里 provider 本身是字符串，
      // 如果直接走下面的「厂商 → 密钥」映射遍历，会把 provider/key 字段名当成厂商名。
      const keyField = ['key', 'api_key', 'apiKey', 'token'].find((f) => typeof obj[f] === 'string')
      const singleRecord =
        Boolean(keyField) &&
        (typeof obj.baseUrl === 'string' ||
          typeof obj.provider === 'string' ||
          typeof obj.providerId === 'string')
      if (singleRecord) {
        items.push(obj)
      } else {
        // 兼容 {"apiKeys": {...}} 包一层的情况
        const holder =
          obj.apiKeys && typeof obj.apiKeys === 'object' && !Array.isArray(obj.apiKeys)
            ? (obj.apiKeys as Record<string, unknown>)
            : obj
        let mapped = 0
        for (const [k, v] of Object.entries(holder)) {
          if (typeof v === 'string') {
            items.push({ provider: k, key: v })
            mapped += 1
          } else if (Array.isArray(v)) {
            for (const one of v) {
              if (typeof one === 'string') {
                items.push({ provider: k, key: one })
                mapped += 1
              }
            }
          }
        }
        // 不是「厂商 → 密钥」映射，就当单条记录处理
        if (mapped === 0) items.push(obj)
      }
    }

    for (const item of items) {
      const wantedId = String(item.provider ?? item.providerId ?? '')
      const byId = matchProvider(wantedId)
      const baseUrlRaw = typeof item.baseUrl === 'string' ? item.baseUrl : ''
      const byUrl =
        !byId && baseUrlRaw
          ? providers.find((p) => normUrl(p.baseUrl) === normUrl(baseUrlRaw)) ??
            providers.find(
              (p) => p.baseUrl && p.baseUrl.toLowerCase().includes(baseUrlRaw.toLowerCase())
            )
          : undefined
      const provider = byId ?? byUrl
      pushEntry(
        provider?.id,
        provider?.baseUrl || baseUrlRaw,
        String(item.key ?? item.api_key ?? item.apiKey ?? item.token ?? '')
      )
    }
  } else if (ext === 'csv' || ext === 'txt') {
    // 按行切，再解析每行的「厂商,密钥」/「厂商|密钥」/全角逗号。
    // 以前这里复用 parseKeysFromText —— 它内部按 /[\r\n,]+/ 切分，逗号在切行时
    // 就被吃掉了，于是每行都不再包含分隔符，CSV 导入恒为 0 条却提示「成功导入」。
    const rawLines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'))
    for (const line of rawLines) {
      const parts = line.split(/[,|，\t]/).map((s) => s.trim())
      if (parts.length < 2) {
        skipped += 1
        continue
      }
      const [a, b] = parts
      const provider = matchProvider(a)
      const baseUrl = provider?.baseUrl || (a.includes('://') ? a : '')
      pushEntry(provider?.id, baseUrl, b)
    }
  } else {
    // 不支持的类型由调用方提示（这里不认得文件名，只按扩展名分支）。
    throw new Error(`unsupported ext: ${ext}`)
  }

  return { entries, skipped }
}

/** 文件导入支持的扩展名（小写，不含点）。 */
export const SUPPORTED_KEY_FILE_EXTS = ['json', 'csv', 'txt']

/**
 * 按真实编码解字节流。导入清单经常来自 Excel/WPS，默认存成 GBK，
 * 而一律当 UTF-8 解——中文标注就会变成「灏忕背」这种乱码，连厂商名都匹配不上。
 * 先认 BOM，再试严格 UTF-8，最后回退 GBK。
 *
 * 从组件里抽出来是为了能直接测（scripts/test-keyfile-import.ts）。
 */
export function decodeTextBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3))
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('gbk').decode(bytes)
  }
}
