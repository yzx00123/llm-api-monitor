export interface Provider {
  id: string
  name: string
  company: string
  baseUrl: string
  balanceUrl?: string
  models: string[]
  protocol: 'openai' | 'anthropic' | 'gemini'
  category: 'international' | 'china' | 'aggregator' | 'custom'
  website?: string
  note?: string
}

export const PROVIDERS: Provider[] = [
  // ─── International ──────────────────────────────────────────
  // Model IDs verified 2026-11-07: real-key 1-token probes where reachable,
  // official pricing/docs + OpenRouter catalog otherwise. Probe uses models[0].
  {
    id: 'openai',
    name: 'OpenAI',
    company: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4o'],
    protocol: 'openai',
    category: 'international',
  },
  {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    company: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    // anthropic.com: claude-haiku-4-5 / claude-sonnet-4-6 (not "claude-haiku-model")
    models: ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5'],
    protocol: 'anthropic',
    category: 'international',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    company: 'Google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    // API accepts gemini-2.5-flash / 2.0-flash (invalid-key probe returns
    // "API key not valid", not model-not-found).
    models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
    protocol: 'gemini',
    category: 'international',
  },
  {
    // Groq = LPU inference company (api.groq.com). NOT xAI's Grok.
    id: 'groq',
    name: 'Groq',
    company: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    // CN egress gets 403 from Groq; ids from Groq's public docs/catalog.
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    protocol: 'openai',
    category: 'international',
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    company: 'xAI',
    baseUrl: 'https://api.x.ai/v1',
    // OpenRouter catalog shows x-ai/grok-4.5 … grok-4.7 (Nov 2026).
    models: ['grok-4.6', 'grok-4.5', 'grok-3-mini'],
    protocol: 'openai',
    category: 'international',
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    company: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    models: ['mistral-small-latest', 'open-mistral-nemo', 'mistral-large-latest'],
    protocol: 'openai',
    category: 'international',
  },
  {
    id: 'together',
    name: 'Together AI',
    company: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo'],
    protocol: 'openai',
    category: 'international',
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    company: 'Perplexity AI',
    baseUrl: 'https://api.perplexity.ai',
    models: ['sonar', 'sonar-pro', 'sonar-reasoning-pro'],
    protocol: 'openai',
    category: 'international',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    company: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    // OpenRouter /api/v1/models catalog (2026-11-07).
    models: [
      'openai/gpt-4o-mini',
      'anthropic/claude-haiku-4.5',
      'google/gemini-2.5-flash',
      'x-ai/grok-4.6',
    ],
    protocol: 'openai',
    category: 'aggregator',
  },

  // ─── China ──────────────────────────────────────────────────
  {
    id: 'deepseek',
    name: 'DeepSeek',
    company: '深度求索',
    baseUrl: 'https://api.deepseek.com',
    balanceUrl: 'https://api.deepseek.com/user/balance',
    // Official API error: "supported API model names are deepseek-flash, deepseek-v4-pro".
    // deepseek-chat / deepseek-reasoner / deepseek-v4-flash still alias to flash.
    models: ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-chat'],
    protocol: 'openai',
    category: 'china',
  },
  {
    id: 'moonshot',
    name: 'Moonshot (月之暗面)',
    company: '月之暗面',
    baseUrl: 'https://api.moonshot.cn/v1',
    balanceUrl: 'https://api.moonshot.cn/v1/users/me/balance',
    // Real-key 200: kimi-k3, kimi-k3.1-pro, kimi-k2.7-code; kimi-k2.6 exists (429 RPM).
    models: ['kimi-k3', 'kimi-k3.1-pro', 'kimi-k2.7-code', 'kimi-k2.6'],
    protocol: 'openai',
    category: 'china',
  },
  {
    id: 'qwen',
    name: '通义千问 (DashScope)',
    company: '阿里巴巴',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    // help.aliyun.com Model Studio list (2026-11).
    models: ['qwen3.8-flash', 'qwen3.8-max', 'qwen-plus', 'qwen-flash'],
    protocol: 'openai',
    category: 'china',
  },
  {
    id: 'zhipu',
    name: '智谱 AI (GLM)',
    company: '智谱华章',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-5.3-flash', 'glm-5.3', 'glm-5.2'],
    protocol: 'openai',
    category: 'china',
  },
  {
    id: 'baichuan',
    name: '百川智能',
    company: '百川智能',
    baseUrl: 'https://api.baichuan-ai.com/v1',
    models: ['Baichuan4', 'Baichuan3-Turbo'],
    protocol: 'openai',
    category: 'china',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    company: 'MiniMax',
    baseUrl: 'https://api.minimax.chat/v1',
    models: ['MiniMax-M3', 'MiniMax-M3.1-Flash', 'abab6.5s-chat'],
    protocol: 'openai',
    category: 'china',
  },
  {
    id: 'lingyiwanwu',
    name: '零一万物 (01.AI)',
    company: '零一万物',
    baseUrl: 'https://api.lingyiwanwu.com/v1',
    models: ['yi-lightning', 'yi-medium'],
    protocol: 'openai',
    category: 'china',
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow (硅基流动)',
    company: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    balanceUrl: 'https://api.siliconflow.cn/v1/user/info',
    // docs.siliconflow.cn text-generation models (2026-11).
    models: ['deepseek-ai/DeepSeek-V3.2', 'Qwen/Qwen3.6-27B', 'deepseek-ai/DeepSeek-V3'],
    protocol: 'openai',
    category: 'aggregator',
  },
  {
    id: 'spark',
    name: '讯飞星火',
    company: '科大讯飞',
    baseUrl: 'https://spark-api-open.xf-yun.com/v1',
    models: ['generalv3.5', '4.0Ultra', 'generalv3'],
    protocol: 'openai',
    category: 'china',
  },
  {
    id: 'stepfun',
    name: '阶跃星辰 (StepFun)',
    company: '阶跃星辰',
    baseUrl: 'https://api.stepfun.com/v1',
    models: ['step-3.7-flash', 'step-3.5-flash', 'step-5-preview'],
    protocol: 'openai',
    category: 'china',
  },
  {
    id: 'volcengine',
    name: '豆包 (火山引擎)',
    company: '字节跳动',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    // volcengine model docs (dots in ids): doubao-seed-2.1-pro etc.
    models: ['doubao-seed-2.1-pro', 'doubao-seed-2.0-pro', 'doubao-seed-2.1-turbo'],
    protocol: 'openai',
    category: 'china',
  },
  {
    id: 'mimo',
    name: '小米 MiMo',
    company: '小米',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    // Console session API — sk- keys cannot query balance; see src/main/mimo.ts
    balanceUrl: 'https://platform.xiaomimimo.com/api/v1/tokenPlan/usage',
    // Real-key 200: mimo-v2.6-pro / mimo-v2.6-flash / mimo-v2.6-pro-ultraspeed
    // (mimo-v2.6 and mimo-v2-flash → 400 Unsupported model)
    models: ['mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2.6-pro-ultraspeed'],
    protocol: 'openai',
    category: 'china',
  },
]

export function detectProvider(base: string): Provider | undefined {
  const normalized = base.replace(/\/+$/, '').toLowerCase()
  return (
    PROVIDERS.find((p) => {
      const url = p.baseUrl.replace(/\/+$/, '').toLowerCase()
      return normalized === url || normalized.startsWith(url + '/')
    }) ?? PROVIDERS.find((p) => normalized.includes(p.id))
  )
}
