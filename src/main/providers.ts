export interface Provider {
  id: string
  name: string
  company: string
  baseUrl: string
  balanceUrl?: string
  models: string[]
  protocol: 'openai' | 'anthropic' | 'gemini'
  category: 'international' | 'china' | 'aggregator'
}

export const PROVIDERS: Provider[] = [
  // ─── International ──────────────────────────────────────────
  {
    id: 'openai',
    name: 'OpenAI',
    company: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo'],
    protocol: 'openai',
    category: 'international',
  },
  {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    company: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    models: ['claude-sonnet-4-20250514', 'claude-haiku-model'],
    protocol: 'anthropic',
    category: 'international',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    company: 'Google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    models: ['gemini-2.0-flash', 'gemini-1.5-pro'],
    protocol: 'gemini',
    category: 'international',
  },
  {
    id: 'groq',
    name: 'Groq',
    company: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768'],
    protocol: 'openai',
    category: 'international',
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    company: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    models: ['mistral-small-latest', 'open-mistral-nemo'],
    protocol: 'openai',
    category: 'international',
  },
  {
    id: 'cohere',
    name: 'Cohere',
    company: 'Cohere',
    baseUrl: 'https://api.cohere.com/v2',
    models: ['command-r-plus', 'command-r'],
    protocol: 'openai',
    category: 'international',
  },
  {
    id: 'together',
    name: 'Together AI',
    company: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo'],
    protocol: 'openai',
    category: 'international',
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    company: 'Perplexity AI',
    baseUrl: 'https://api.perplexity.ai',
    models: ['sonar', 'sonar-pro'],
    protocol: 'openai',
    category: 'international',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    company: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['openai/gpt-4o', 'anthropic/claude-3.5-sonnet'],
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
    models: ['deepseek-chat', 'deepseek-reasoner'],
    protocol: 'openai',
    category: 'china',
  },
  {
    id: 'moonshot',
    name: 'Moonshot (月之暗面)',
    company: '月之暗面',
    baseUrl: 'https://api.moonshot.cn/v1',
    balanceUrl: 'https://api.moonshot.cn/v1/users/me/balance',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k'],
    protocol: 'openai',
    category: 'china',
  },
  {
    id: 'qwen',
    name: '通义千问 (DashScope)',
    company: '阿里巴巴',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-turbo', 'qwen-plus', 'qwen-max'],
    protocol: 'openai',
    category: 'china',
  },
  {
    id: 'zhipu',
    name: '智谱 AI (GLM)',
    company: '智谱华章',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-flash', 'glm-4-plus'],
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
    models: ['abab6.5s-chat', 'abab5.5-chat'],
    protocol: 'openai',
    category: 'china',
  },
  {
    id: 'lingyiwanwu',
    name: '零一万物 (01.AI)',
    company: '零一万物',
    baseUrl: 'https://api.lingyiwanwu.com/v1',
    models: ['yi-lightning', 'yi-large'],
    protocol: 'openai',
    category: 'china',
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow (硅基流动)',
    company: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    balanceUrl: 'https://api.siliconflow.cn/v1/user/info',
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct'],
    protocol: 'openai',
    category: 'aggregator',
  },
  {
    id: 'spark',
    name: '讯飞星火',
    company: '科大讯飞',
    baseUrl: 'https://spark-api-open.xf-yun.com/v1',
    models: ['generalv3.5', 'generalv3'],
    protocol: 'openai',
    category: 'china',
  },
  {
    id: 'stepfun',
    name: '阶跃星辰 (StepFun)',
    company: '阶跃星辰',
    baseUrl: 'https://api.stepfun.com/v1',
    models: ['step-1-8k', 'step-2-16k'],
    protocol: 'openai',
    category: 'china',
  },
  {
    id: 'volcengine',
    name: '豆包 (火山引擎)',
    company: '字节跳动',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['doubao-pro-4k'],
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
