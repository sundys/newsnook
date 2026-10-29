/**
 * 把 WebDAV 同步引擎接到 React 运行时。
 *
 * 触发策略（无轮询、无 WebSocket）：
 *   配置完成后冷启动 · 本地改动 debounce · 回到前台 · 网络恢复 · 手动
 *
 * 未配置时这个 hook 什么都不做：不创建引擎、不发请求、不影响任何本地阅读路径。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'

import { log } from '../../lib/logger'
import { loadWebDavState } from '../../lib/storage'
import { hydrateWebDavPassword } from './credentials'
import { WebDavSyncEngine } from './engine'
import type { WebDavConflict, WebDavSyncReason } from './engine'
import {
  IDLE_WEBDAV_STATUS,
  isWebDavConfigured,
  normalizeWebDavState,
} from './state'
import type { WebDavDirection, WebDavStatus } from './state'

/** 本地改动合并窗口：连续调整设置时只在停手后推一次 */
const LOCAL_CHANGE_DEBOUNCE_MS = 3000

export interface WebDavSyncArgs {
  /** 配置变化（地址 / 账号 / 自动同步开关）后递增，用来重建引擎 */
  configVersion: number
  /** 当前本机配置的内容指纹；变化即视为「本机改了东西」 */
  localChangeKey: string
  engineFactory: (onStatus: (status: WebDavStatus) => void) => WebDavSyncEngine | null
}

export interface WebDavSyncApi {
  status: WebDavStatus
  configured: boolean
  syncNow: () => Promise<void>
  /** 保存设置后验证地址、凭证与目录可用性 */
  testConnection: () => Promise<void>
  resolveConflict: (direction: WebDavDirection) => Promise<void>
  dismissConflict: () => void
  /** 忽略判定，直接把本机这份覆盖到网盘 */
  forceUpload: () => Promise<void>
  /** 忽略判定，用网盘那份覆盖本机（覆盖前会先留快照） */
  forceDownload: () => Promise<void>
  conflict: WebDavConflict | null
}

export function useWebDavSync(args: WebDavSyncArgs): WebDavSyncApi {
  const { configVersion, localChangeKey, engineFactory } = args
  const [status, setStatus] = useState<WebDavStatus>(IDLE_WEBDAV_STATUS)
  const [configured, setConfigured] = useState(
    () => isWebDavConfigured(normalizeWebDavState(loadWebDavState())),
  )
  const [engine, setEngine] = useState<WebDavSyncEngine | null>(null)

  const factoryRef = useRef(engineFactory)
  factoryRef.current = engineFactory

  // 配置变化后重建引擎；引擎自身无状态，地址 / 账号 / 基线都从 storage 读
  useEffect(() => {
    const next = factoryRef.current(setStatus)
    setEngine(next)
    setConfigured(isWebDavConfigured(normalizeWebDavState(loadWebDavState())))
    if (!next) {
      setStatus(IDLE_WEBDAV_STATUS)
      return
    }
    setStatus(next.getStatus())

    // 冷启动：先把 Keystore 里的密码读回内存，再跑一轮（失败只体现在状态里）
    let cancelled = false
    void hydrateWebDavPassword()
      .then(() => {
        if (!cancelled) return next.sync('startup')
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [configVersion])

  const lastKey = useRef<string | null>(null)
  useEffect(() => {
    if (!engine || !configured) return
    if (lastKey.current === null) {
      lastKey.current = localChangeKey
      return
    }
    if (lastKey.current === localChangeKey) return
    lastKey.current = localChangeKey
    const timer = window.setTimeout(() => {
      void engine.sync('local-change').catch(() => {})
    }, LOCAL_CHANGE_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [engine, configured, localChangeKey])

  useEffect(() => {
    if (!engine || !configured) return

    const onForeground = () => {
      void engine.sync('foreground').catch(() => {})
    }

    if (Capacitor.isNativePlatform()) {
      let handle: { remove: () => Promise<void> } | undefined
      let disposed = false
      void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
        if (isActive) onForeground()
      }).then((registered) => {
        if (disposed) void registered.remove()
        else handle = registered
      })
      return () => {
        disposed = true
        void handle?.remove()
      }
    }

    const onVisible = () => {
      if (document.visibilityState === 'visible') onForeground()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [engine, configured])

  useEffect(() => {
    if (!engine || !configured) return
    const onOnline = () => {
      log.sync.debug('network back online, syncing webdav')
      void engine.sync('network').catch(() => {})
    }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [engine, configured])

  const syncNow = useCallback(async () => {
    if (!engine) return
    await engine.sync('manual' satisfies WebDavSyncReason)
  }, [engine])

  const testConnection = useCallback(async () => {
    if (!engine) return
    await engine.testConnection()
  }, [engine])

  const forceUpload = useCallback(async () => {
    if (!engine) return
    await engine.forceUpload()
  }, [engine])

  const forceDownload = useCallback(async () => {
    if (!engine) return
    await engine.forceDownload()
  }, [engine])

  const resolveConflict = useCallback(
    async (direction: WebDavDirection) => {
      if (!engine) return
      await engine.resolve(direction)
    },
    [engine],
  )

  const dismissConflict = useCallback(() => {
    engine?.dismissConflict()
  }, [engine])

  return {
    status,
    configured,
    syncNow,
    testConnection,
    resolveConflict,
    dismissConflict,
    forceUpload,
    forceDownload,
    conflict: status.pendingConflict,
  }
}
