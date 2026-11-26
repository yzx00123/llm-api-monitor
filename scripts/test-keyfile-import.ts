// 密钥管理「文件导入」自测：直接跑 src/renderer/src/lib/parseKeyFile.ts 这个纯函数。
//
// 背景（用户要求「你自己去测一下」）：解析逻辑原来埋在 React 组件里没法测，
// 已抽成纯函数。这里覆盖历史上踩过的坑：
//   - CSV 按 /[\r\n,]+/ 切行把逗号吃掉 → 恒 0 条却提示成功
//   - JSON 只认数组 → {"deepseek": ["sk-1"]} 映射格式静默 0 条
//   - 单条记录 { provider, baseUrl, key } 被当成「厂商→密钥」映射
//   - 匹配不上厂商的条目以前被塞进不存在的 providerId 'custom'
//
// 运行：node scripts/test-keyfile-import.ts  （Node 24 原生跑 TS）
import { parseKeyFile, decodeTextBytes, SUPPORTED_KEY_FILE_EXTS } from '../src/renderer/src/lib/parseKeyFile.ts'
import type { Provider } from '../src/preload/index.ts'

let passed = 0
let failed = 0

function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed += 1
    console.log(`  ok  ${name}`)
  } else {
    failed += 1
    console.error(`FAIL  ${name}`, detail !== undefined ? JSON.stringify(detail) : '')
  }
}

// 两个假供应商：一个内置厂商（有 baseUrl），一个无 baseUrl 的厂商。
const providers = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: [],
    protocol: 'openai',
    category: 'builtin'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: [],
    protocol: 'openai',
    category: 'builtin'
  },
  // 中文名厂商：验证 GBK 清单解码后厂商名还能匹配上
  {
    id: 'xiaomi',
    name: '小米',
    baseUrl: 'https://api.xiaomi.com/v1',
    models: [],
    protocol: 'openai',
    category: 'builtin'
  }
] as unknown as Provider[]

console.log('== 支持的扩展名 ==')
check('json/csv/txt 在白名单', ['json', 'csv', 'txt'].every((e) => SUPPORTED_KEY_FILE_EXTS.includes(e)))
check('md 不在白名单', !SUPPORTED_KEY_FILE_EXTS.includes('md'))

console.log('== JSON：数组（导出格式） ==')
{
  const text = JSON.stringify([
    { provider: 'deepseek', key: 'sk-ds-1' },
    { provider: 'openai', key: 'sk-oa-1' }
  ])
  const { entries, skipped } = parseKeyFile(text, 'json', providers)
  check('解析出 2 条', entries.length === 2, entries)
  check('deepseek 归到 deepseek', entries[0]?.providerId === 'deepseek' && entries[0]?.key === 'sk-ds-1')
  check('openai 归到 openai', entries[1]?.providerId === 'openai')
  check('没有跳过', skipped === 0, skipped)
}

console.log('== JSON：厂商→密钥 映射（历史 bug：静默 0 条） ==')
{
  const { entries } = parseKeyFile(JSON.stringify({ deepseek: ['sk-a', 'sk-b'], openai: 'sk-c' }), 'json', providers)
  check('解析出 3 条', entries.length === 3, entries)
  check('数组值拆开', entries.filter((e) => e.providerId === 'deepseek').length === 2)
  check('字符串值直收', entries.some((e) => e.providerId === 'openai' && e.key === 'sk-c'))
}

console.log('== JSON：apiKeys 包一层 ==')
{
  const { entries } = parseKeyFile(JSON.stringify({ apiKeys: { deepseek: 'sk-wrap' } }), 'json', providers)
  check('解析出 1 条', entries.length === 1, entries)
  check('provider 正确', entries[0]?.providerId === 'deepseek' && entries[0]?.key === 'sk-wrap')
}

console.log('== JSON：单条记录 { provider, baseUrl, key }（历史 bug：字段名被当厂商名） ==')
{
  const { entries } = parseKeyFile(
    JSON.stringify({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', key: 'sk-single' }),
    'json',
    providers
  )
  check('解析出 1 条', entries.length === 1, entries)
  check('不是把 provider/key 字段名当厂商', entries[0]?.providerId === 'deepseek' && entries[0]?.key === 'sk-single', entries)
}

console.log('== JSON：中转站（baseUrl 匹配不到内置厂商 → 不带 providerId，交给主进程建供应商） ==')
{
  const { entries, skipped } = parseKeyFile(
    JSON.stringify([{ baseUrl: 'https://relay.example.com/v1', key: 'sk-relay' }]),
    'json',
    providers
  )
  check('解析出 1 条', entries.length === 1, entries)
  check('providerId 留空', entries[0]?.providerId === undefined, entries)
  check('baseUrl 保留', entries[0]?.baseUrl === 'https://relay.example.com/v1')
  check('没有误跳过', skipped === 0, skipped)
}

console.log('== JSON：既无 baseUrl 也无 key → 跳过并计数 ==')
{
  const { entries, skipped } = parseKeyFile(JSON.stringify([{ note: 'nothing' }, { provider: 'deepseek', key: 'sk-ok' }]), 'json', providers)
  check('只留 1 条', entries.length === 1, entries)
  check('跳过 1 条', skipped === 1, skipped)
}

console.log('== JSON：坏 JSON 抛错（界面显示「文件解析失败」） ==')
{
  let threw = false
  try {
    parseKeyFile('{ not json', 'json', providers)
  } catch {
    threw = true
  }
  check('抛错', threw)
}

console.log('== CSV（历史 bug：逗号被切行吃掉，恒 0 条） ==')
{
  const text = ['# 导出清单', 'deepseek,sk-csv-1', 'openai,sk-csv-2', '', 'badline'].join('\r\n')
  const { entries, skipped } = parseKeyFile(text, 'csv', providers)
  check('解析出 2 条（逗号保留）', entries.length === 2, entries)
  check('deepseek 行正确', entries[0]?.providerId === 'deepseek' && entries[0]?.key === 'sk-csv-1')
  check('openai 行正确', entries[1]?.providerId === 'openai' && entries[1]?.key === 'sk-csv-2')
  check('无分隔符行跳过 1 条', skipped === 1, skipped)
  check('注释行和空行不算跳过', skipped === 1)
}

console.log('== TXT：竖线 / 全角逗号 / 制表符分隔 ==')
{
  const text = ['deepseek|sk-bar-1', 'openai，sk-fullwidth-1', 'deepseek\tsk-tab-1'].join('\n')
  const { entries, skipped } = parseKeyFile(text, 'txt', providers)
  check('解析出 3 条', entries.length === 3, entries)
  check('竖线', entries[0]?.key === 'sk-bar-1')
  check('全角逗号', entries[1]?.key === 'sk-fullwidth-1')
  check('制表符', entries[2]?.key === 'sk-tab-1')
  check('没有跳过', skipped === 0, skipped)
}

console.log('== TXT：未知厂商且不是 URL → 跳过（不塞进假的 custom 桶） ==')
{
  const { entries, skipped } = parseKeyFile('未知厂商,sk-x', 'txt', providers)
  check('0 条', entries.length === 0, entries)
  check('跳过 1 条', skipped === 1, skipped)
}

console.log('== TXT：厂商名大小写不敏感 ==')
{
  const { entries } = parseKeyFile('DeepSeek,sk-case', 'txt', providers)
  check('匹配到 deepseek', entries[0]?.providerId === 'deepseek', entries)
}

console.log('== CSV 小写扩展名（调用方已 toLowerCase，这里确认函数只认小写） ==')
{
  const { entries } = parseKeyFile('deepseek,sk-lower', 'csv', providers)
  check('csv 正常', entries.length === 1)
  let threw = false
  try {
    parseKeyFile('deepseek,sk-upper', 'CSV', providers)
  } catch {
    threw = true
  }
  check('大写 CSV 抛 unsupported（由调用方先 toLowerCase 拦下）', threw)
}

console.log('== 编码判定 decodeTextBytes（历史 bug：GBK 清单乱码，厂商名匹配不上） ==')
{
  const enc = new TextEncoder()
  // 纯 UTF-8
  check('UTF-8 直解', decodeTextBytes(enc.encode('deepseek,sk-1')) === 'deepseek,sk-1')
  // UTF-8 + BOM（Excel 另存 UTF-8 常带 BOM；BOM 不剥会污染首行）
  const utf8bom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode('deepseek,sk-1')])
  check('UTF-8 BOM 被剥掉', decodeTextBytes(utf8bom) === 'deepseek,sk-1', JSON.stringify(decodeTextBytes(utf8bom)))
  // GBK：「小米,sk-gbk」——若被当 UTF-8 解会变成乱码或抛错
  // （字节来自 .NET CP936：小=D0A1 米=C3D7）
  const gbkBytes = new Uint8Array([
    0xd0, 0xa1, 0xc3, 0xd7, // 小米 (GBK)
    0x2c, // ,
    0x73, 0x6b, 0x2d, 0x67, 0x62, 0x6b // sk-gbk
  ])
  const gbkOut = decodeTextBytes(gbkBytes)
  check('GBK 回退解出中文', gbkOut === '小米,sk-gbk', JSON.stringify(gbkOut))
  // 解出来后还能被解析（端到端：GBK 清单 → 密钥条目）
  const gbkParsed = parseKeyFile(gbkOut, 'csv', providers)
  check('GBK 清单能解析成条目', gbkParsed.entries.length === 1 && gbkParsed.entries[0]?.key === 'sk-gbk', gbkParsed)
  // UTF-16LE + BOM（记事本另存为「Unicode」的默认格式）
  const u16 = new Uint8Array([0xff, 0xfe, ...Buffer.from('deepseek,sk-u16', 'utf16le')])
  check('UTF-16LE BOM 解出', decodeTextBytes(u16) === 'deepseek,sk-u16', JSON.stringify(decodeTextBytes(u16)))
}

console.log('')
console.log(`结果: ${passed} 通过, ${failed} 失败`)
if (failed > 0) process.exit(1)
