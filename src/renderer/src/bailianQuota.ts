import { useEffect, useState } from 'react'
import type { FreeQuotaResult } from './preload'

/**
 * 阿里云百炼免费额度：一次拉取、全局共享。
 *
 * 额度是「账号级 + 按模型」的数据，卡片和账单页都要用。如果每个组件各自去拉，
 * 每开一个页面就打一次阿里云接口，所以这里做一个极简的模块级 store：
 * 第一次用到时拉一次，之后所有订阅者共享同一份结果，需要更新时调 refresh()。
 */

let data: FreeQuotaResult | null = null
let loading = false
let lastError: string | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

async function load(force: boolean): Promise<void> {
  if (loading) return
  loading = true
  emit()
  try {
    const result = await window.electronAPI.bailianGetQuota(force)
    data = result
    lastError = result.ok ? null : result.error ?? '读取免费额度失败'
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err)
  } finally {
    loading = false
    emit()
  }
}

/** 主动刷新（会打一次网络请求）；登录成功后也可以调它。 */
export function refreshBailianQuota(force = true): Promise<void> {
  return load(force)
}

export function useBailianQuota(): {
  data: FreeQuotaResult | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
} {
  const [, setTick] = useState(0)

  useEffect(() => {
    const listener = () => setTick((n) => n + 1)
    listeners.add(listener)
    // 首屏：还没数据、也没在拉，就拉一次（走主进程 5 分钟缓存，不会真打接口）
    if (!data && !loading) void load(false)
    return () => {
      listeners.delete(listener)
    }
  }, [])

  return { data, loading, error: lastError, refresh: () => load(true) }
}
