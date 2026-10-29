/**
 * WebDAV 同步引擎：把本机配置整包推到用户自己的网盘，或从网盘整包拉回。
 *
 * 与 NewsNook Cloud 的 SyncEngine 不同，这里没有服务端合并：
 * 一份 `BackupPayload` 就是同步单元，判定与裁决都集中在 `state.ts` 的纯函数里。
 *
 * 三条硬边界：
 * - 网盘不可达只是这一页报错，阅读、订阅、正文抽取完全不依赖它
 * - 覆盖本机之前一定先落一份本机快照，选错了还能整包回滚
 * - 密码只在内存与 Keystore，日志里只有动词与主机名
 */

import {
  captureSyncSafetySnapshot,
  parseBackup,
  restoreBackup,
  serializeBackup,
} from '../../lib/backup'
import type { BackupPayload } from '../../lib/backup'
import { log } from '../../lib/logger'
import { loadWebDavState, saveWebDavState } from '../../lib/storage'
import { fingerprintOf } from '../sync/fingerprint'
import {
  WebDavError,
  webDavCheckConnection,
  webDavDownload,
  webDavEnsureDirectory,
  webDavUpload,
  type WebDavConfig,
} from './client'
import { getRuntimeWebDavPassword, hydrateWebDavPassword } from './credentials'
import {
  backupContentKey,
  decideWebDavSync,
  normalizeWebDavState,
  summarizeSide,
} from './state'
import type {
  WebDavDirection,
  WebDavStatus,
  WebDavSyncAction,
  WebDavSyncState,
} from './state'

export interface WebDavRuntime {
  /** 当前本机配置的备份快照（含导出时间） */
  collect: () => BackupPayload
  /** 把网盘内容整包写回本机；实现方负责重载运行时状态 */
  applyRemote: (payload: BackupPayload) => Promise<void>
}

export interface WebDavEngineEvents {
  onStatus: (status: WebDavStatus) => void
}

export type WebDavSyncReason = 'startup' | 'local-change' | 'foreground' | 'network' | 'manual'

export interface WebDavConflict {
  local: ReturnType<typeof summarizeSide>
  remote: ReturnType<typeof summarizeSide>
}

export interface WebDavEngineResult {
  action: WebDavSyncAction
  /** 需要用户裁决时带出两份摘要 */
  conflict?: WebDavConflict
}

function configFromState(state: WebDavSyncState, password: string): WebDavConfig {
  return {
    baseUrl: state.baseUrl,
    username: state.username,
    password,
    authMode: 'basic',
  }
}

/** 本机备份的指纹：只比内容，导出时间不同不算改动 */
export function fingerprintPayload(payload: BackupPayload): string {
  return fingerprintOf(backupContentKey(payload))
}

export class WebDavSyncEngine {
  private readonly runtime: WebDavRuntime
  private readonly events: WebDavEngineEvents
  private status: WebDavStatus = {
    phase: 'idle',
    lastSyncedAt: null,
    lastError: null,
    pendingConflict: null,
  }
  private running = false
  private pendingConflict: WebDavConflict | null = null
  private pendingRemote: BackupPayload | null = null
  private pendingLocal: BackupPayload | null = null

  constructor(runtime: WebDavRuntime, events: WebDavEngineEvents) {
    this.runtime = runtime
    this.events = events
  }

  getStatus(): WebDavStatus {
    return this.status
  }

  private setStatus(patch: Partial<WebDavStatus>): void {
    this.status = { ...this.status, ...patch }
    this.events.onStatus(this.status)
  }

  private readState(): WebDavSyncState {
    return normalizeWebDavState(loadWebDavState())
  }

  private writeState(next: WebDavSyncState): void {
    saveWebDavState(next)
  }

  private async config(): Promise<WebDavConfig> {
    const state = this.readState()
    const password = getRuntimeWebDavPassword() || (await hydrateWebDavPassword())
    return configFromState(state, password)
  }

  /** 保存设置（账号 / 地址 / 自动同步）后调用：先验连通性，再重跑一次同步 */
  async configure(
    patch: Pick<WebDavSyncState, 'baseUrl' | 'username'> & { autoSync?: boolean },
  ): Promise<void> {
    const next: WebDavSyncState = {
      ...this.readState(),
      ...patch,
      // 换了地址或账号，旧基线不再可信，下一次同步重新判定方向
      localFingerprint: '',
      remoteFingerprint: '',
    }
    this.writeState(next)
    this.setStatus({ phase: 'idle', lastError: null, pendingConflict: null })
  }

  async testConnection(config?: WebDavConfig): Promise<void> {
    const target = config ?? (await this.config())
    await webDavCheckConnection(target)
  }

  async sync(reason: WebDavSyncReason): Promise<WebDavEngineResult> {
    const state = this.readState()
    if (!state.baseUrl) return { action: 'up-to-date' }
    if (!state.autoSync && reason !== 'manual') return { action: 'up-to-date' }
    // 上一轮还没跑完：本地改动会再触发一次，不排队
    if (this.running) return { action: 'up-to-date' }

    this.running = true
    this.setStatus({ phase: 'syncing', lastError: null })
    try {
      const result = await this.run(state)
      return result
    } catch (error) {
      this.reportError(error)
      throw error
    } finally {
      this.running = false
    }
  }

  private async run(state: WebDavSyncState): Promise<WebDavEngineResult> {
    const config = await this.config()
    await webDavEnsureDirectory(config)

    const local = this.runtime.collect()
    const remoteFile = await webDavDownload(config)
    const remote = remoteFile.exists ? safeParse(remoteFile.text) : null

    if (remoteFile.exists && !remote) {
      // 网盘上是坏文件：绝不自动覆盖，交给用户确认后手动上传
      throw new WebDavError(
        'SERVER',
        '网盘上的同步文件无法解析，可能是别的程序写坏的；请确认后在页面上手动上传覆盖',
      )
    }

    const action = decideWebDavSync({
      localFingerprint: fingerprintPayload(local),
      remoteFingerprint: remote ? fingerprintPayload(remote) : '',
      state,
      remoteExists: remoteFile.exists,
    })

    switch (action) {
      case 'up-to-date':
        this.markSynced(state, local, remote ?? local)
        return { action }

      case 'upload-initial':
      case 'upload':
        await this.upload(config, local)
        this.markSynced(state, local, local)
        return { action }

      case 'download':
        if (remote) {
          // 先记基线再覆盖本机，避免覆盖动作被下一轮当成「本机改动」又推回网盘
          this.markBaseline(remote, remote)
          await this.applyRemote(remote, local)
          this.markSynced(state, remote, remote)
        }
        return { action }

      case 'conflict':
      case 'unknown-baseline':
        if (!remote) return { action: 'up-to-date' }
        this.pendingLocal = local
        this.pendingRemote = remote
        this.pendingConflict = { local: summarizeSide(local), remote: summarizeSide(remote) }
        this.setStatus({ phase: 'conflict', pendingConflict: this.pendingConflict })
        return { action, conflict: this.pendingConflict }

      default:
        return { action }
    }
  }

  private async upload(config: WebDavConfig, payload: BackupPayload): Promise<void> {
    const text = serializeBackup(payload)
    await webDavUpload(config, text)
    log.sync.info('webdav uploaded', { bytes: text.length })
  }

  private async applyRemote(remote: BackupPayload, local: BackupPayload): Promise<void> {
    // 覆盖前先留一份本机快照：网盘那份可能比本机旧，用户随时能退回去
    captureSyncSafetySnapshot(local.appVersion)
    await restoreBackup(remote)
    await this.runtime.applyRemote(remote)
    log.sync.info('webdav applied remote config', { sections: Object.keys(remote.data) })
  }

  private markSynced(_state: WebDavSyncState, local: BackupPayload, remote: BackupPayload): void {
    const now = Date.now()
    this.writeState({
      ...this.readState(),
      localFingerprint: fingerprintPayload(local),
      remoteFingerprint: fingerprintPayload(remote),
      lastSyncedAt: now,
    })
    this.pendingConflict = null
    this.pendingLocal = null
    this.pendingRemote = null
    this.setStatus({ phase: 'idle', lastSyncedAt: now, lastError: null, pendingConflict: null })
  }

  /**
   * 先写基线再应用远端：应用完本机指纹就变了，若此时才写基线会把「刚拉下来的内容」
   * 记成本机改动，下一轮再推回去。
   */
  private markBaseline(local: BackupPayload, remote: BackupPayload): void {
    this.writeState({
      ...this.readState(),
      localFingerprint: fingerprintPayload(local),
      remoteFingerprint: fingerprintPayload(remote),
      lastSyncedAt: Date.now(),
    })
  }

  /** 用户在弹窗里选完方向后调用 */
  async resolve(direction: WebDavDirection): Promise<WebDavEngineResult> {
    if (!this.pendingLocal || !this.pendingRemote) {
      throw new WebDavError('CONFLICT', '没有待处理的同步冲突')
    }
    const config = await this.config()
    this.setStatus({ phase: 'syncing', pendingConflict: null })
    try {
      if (direction === 'upload') {
        await this.upload(config, this.pendingLocal)
        this.markSynced(this.readState(), this.pendingLocal, this.pendingLocal)
        return { action: 'upload' }
      }
      this.markBaseline(this.pendingRemote, this.pendingRemote)
      await this.applyRemote(this.pendingRemote, this.pendingLocal)
      this.markSynced(this.readState(), this.pendingRemote, this.pendingRemote)
      return { action: 'download' }
    } catch (error) {
      this.reportError(error)
      throw error
    }
  }

  dismissConflict(): void {
    this.pendingConflict = null
    this.pendingLocal = null
    this.pendingRemote = null
    this.setStatus({ phase: 'idle', pendingConflict: null })
  }

  /** 手动上传：忽略判定，直接把本机这份覆盖到网盘 */
  async forceUpload(): Promise<void> {
    const config = await this.config()
    const local = this.runtime.collect()
    await this.upload(config, local)
    this.markSynced(this.readState(), local, local)
  }

  /** 手动下载：忽略判定，用网盘那份覆盖本机（覆盖前会先留快照） */
  async forceDownload(): Promise<void> {
    const config = await this.config()
    const remoteFile = await webDavDownload(config)
    if (!remoteFile.exists) throw new WebDavError('NOT_FOUND', '网盘上还没有同步文件')
    const remote = safeParse(remoteFile.text)
    if (!remote) throw new WebDavError('SERVER', '网盘上的同步文件无法解析')
    const local = this.runtime.collect()
    this.markBaseline(remote, remote)
    await this.applyRemote(remote, local)
    this.markSynced(this.readState(), remote, remote)
  }

  private reportError(error: unknown): void {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false
    const message =
      error instanceof WebDavError
        ? error.message
        : '同步失败，请稍后重试'
    this.setStatus({ phase: offline ? 'offline' : 'error', lastError: message })
  }
}

function safeParse(text: string): BackupPayload | null {
  try {
    return parseBackup(text)
  } catch {
    return null
  }
}
