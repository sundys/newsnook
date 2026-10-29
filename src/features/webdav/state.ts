/**
 * WebDAV 同步的本机状态与「要不要传 / 要不要拉」的判定（纯函数，便于直接断言）。
 *
 * 同步对象是一整份 `BackupPayload`（见 lib/backup.ts），不拆实体：
 * 网盘是用户自己的文件存储，没有服务端合并能力，整包比较与整包替换最简单也最可预期。
 *
 * 判定依据是「指纹」而不是时间戳：本机内容没变就绝不覆盖网盘，
 * 网盘内容没变就不必下载。只有两边都变了才需要用户裁决。
 */

import type { BackupPayload } from '../../lib/backup'

/** 只记地址、账号、指纹与时间：密码进 Keystore，配置副本始终在本机存储与网盘文件里 */
export interface WebDavSyncState {
  /** 用户填写的 WebDAV 根地址；空串表示尚未配置 */
  baseUrl: string
  username: string
  /** 上次同步成功时，本机那份备份的指纹 */
  localFingerprint: string
  /** 上次同步成功时，网盘那份备份的指纹 */
  remoteFingerprint: string
  lastSyncedAt: number | null
  /** 用户主动关闭自动同步后仍保留配置，只是不再自动跑 */
  autoSync: boolean
}

export const DEFAULT_WEBDAV_STATE: WebDavSyncState = {
  baseUrl: '',
  username: '',
  localFingerprint: '',
  remoteFingerprint: '',
  lastSyncedAt: null,
  autoSync: true,
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function normalizeWebDavState(raw: unknown): WebDavSyncState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_WEBDAV_STATE }
  const record = raw as Record<string, unknown>
  const lastSyncedAt =
    typeof record.lastSyncedAt === 'number' && Number.isFinite(record.lastSyncedAt)
      ? record.lastSyncedAt
      : null
  return {
    baseUrl: text(record.baseUrl),
    username: text(record.username),
    localFingerprint: text(record.localFingerprint),
    remoteFingerprint: text(record.remoteFingerprint),
    lastSyncedAt,
    // 缺省视为开启：老用户升级后不必再手动打开
    autoSync: record.autoSync !== false,
  }
}

export function isWebDavConfigured(state: WebDavSyncState): boolean {
  return Boolean(state.baseUrl.trim())
}

/**
 * 设备本地设置跟着硬件与本机容量走，网盘那份不覆盖它们。
 * 与 NewsNook Cloud 同步的 `DEVICE_LOCAL_SETTING_FIELDS` 保持同一口径。
 */
export const DEVICE_LOCAL_PREFERENCE_FIELDS = ['einkMode', 'wifiOnlyAutoLoadMedia', 'prestore'] as const

export function keepDeviceLocalPreferences<T extends object>(incoming: T, current: object): T {
  const merged = { ...incoming } as Record<string, unknown>
  const source = current as Record<string, unknown>
  for (const field of DEVICE_LOCAL_PREFERENCE_FIELDS) {
    if (field in source) merged[field] = source[field]
  }
  return merged as T
}

/** 比较「配置内容」而不是文件字节：导出时间不同不该算改动 */
export function backupContentKey(payload: BackupPayload): unknown {
  return { version: payload.version, data: payload.data }
}

export type WebDavSyncAction =
  /** 网盘上还没有文件：直接把本机传上去 */
  | 'upload-initial'
  /** 只有本机变了：上传 */
  | 'upload'
  /** 只有网盘变了：下载 */
  | 'download'
  /** 两边一致，什么都不用做 */
  | 'up-to-date'
  /** 两边都变了：必须让用户选 */
  | 'conflict'
  /** 没有本地基线（首次启用但网盘已有文件）：让用户选方向 */
  | 'unknown-baseline'

export interface WebDavDecisionInput {
  localFingerprint: string
  remoteFingerprint: string
  state: WebDavSyncState
  /** 网盘上是否已经有同步文件 */
  remoteExists: boolean
}

export function decideWebDavSync(input: WebDavDecisionInput): WebDavSyncAction {
  const { localFingerprint, remoteFingerprint, state, remoteExists } = input

  if (!remoteExists) return 'upload-initial'
  if (localFingerprint === remoteFingerprint) return 'up-to-date'

  const hasBaseline = Boolean(state.localFingerprint && state.remoteFingerprint)
  if (!hasBaseline) return 'unknown-baseline'

  const localChanged = localFingerprint !== state.localFingerprint
  const remoteChanged = remoteFingerprint !== state.remoteFingerprint

  if (localChanged && remoteChanged) return 'conflict'
  if (localChanged) return 'upload'
  if (remoteChanged) return 'download'
  // 两边都与基线不同但彼此相同的情况已在上面处理；走到这里说明基线自身已过期
  return 'conflict'
}

export type WebDavDirection = 'upload' | 'download'

/**
 * 冲突时的默认方向：取 `exportedAt` 较新的一份。
 * 导出时间是「这份配置最后一次被改动」的近似值，换机场景下通常就是用户刚用过的那台。
 */
export function preferNewerSide(localExportedAt: number, remoteExportedAt: number): WebDavDirection {
  return remoteExportedAt > localExportedAt ? 'download' : 'upload'
}

/** 两边导出时间差在这个窗口内视为「同一轮改动」，不给倾向，让用户自己看内容决定 */
export const SAME_ROUND_MS = 60_000

export function isSameRound(localExportedAt: number, remoteExportedAt: number): boolean {
  return Math.abs(localExportedAt - remoteExportedAt) < SAME_ROUND_MS
}

export interface WebDavSideSummary {
  exportedAt: number
  appVersion?: string
  /** 各分区是否有内容，用于弹窗里讲清楚「这份里有什么」 */
  hasPreferences: boolean
  hasPresets: boolean
  enabledSourceCount: number
  laterCount: number
  readCount: number
  readingPositionCount: number
}

export function summarizeSide(payload: BackupPayload): WebDavSideSummary {
  const { data } = payload
  return {
    exportedAt: payload.exportedAt,
    ...(payload.appVersion ? { appVersion: payload.appVersion } : {}),
    hasPreferences: data.preferences != null,
    hasPresets: data.presets != null,
    enabledSourceCount: data.enabledSources?.length ?? 0,
    laterCount: data.laterItems?.length ?? 0,
    readCount: data.readIds?.length ?? 0,
    readingPositionCount:
      data.readingPositions && typeof data.readingPositions === 'object'
        ? Object.keys(data.readingPositions as Record<string, unknown>).length
        : 0,
  }
}

/** 一行说明：同步完成后给用户看的「这次动了什么」 */
export function describeAction(action: WebDavSyncAction): string {
  switch (action) {
    case 'upload-initial':
      return '已把本机配置上传到网盘'
    case 'upload':
      return '本机配置已同步到网盘'
    case 'download':
      return '已从网盘恢复配置'
    case 'up-to-date':
      return '本机与网盘一致'
    case 'conflict':
      return '本机与网盘都有改动，需要选择保留哪一份'
    case 'unknown-baseline':
      return '网盘上已有一份配置，需要选择同步方向'
    default:
      return ''
  }
}

export type WebDavPhase =
  | 'idle'
  | 'syncing'
  | 'offline'
  | 'error'
  /** 等用户在弹窗里选方向 */
  | 'conflict'

export interface WebDavStatus {
  phase: WebDavPhase
  lastSyncedAt: number | null
  lastError: string | null
  /** 当前待裁决的方向选择；null 表示没有 */
  pendingConflict: { local: WebDavSideSummary; remote: WebDavSideSummary } | null
}

export const IDLE_WEBDAV_STATUS: WebDavStatus = {
  phase: 'idle',
  lastSyncedAt: null,
  lastError: null,
  pendingConflict: null,
}

/** 设置页与「我的」里的一行状态说明 */
export function webDavStatusCaption(
  status: WebDavStatus,
  options: { configured: boolean; now?: number },
): string {
  if (!options.configured) return '未配置 · 本地阅读不受影响'
  switch (status.phase) {
    case 'syncing':
      return '正在同步…'
    case 'offline':
      return '离线 · 恢复网络后自动同步'
    case 'conflict':
      return '本机与网盘不一致 · 等待选择'
    case 'error':
      return status.lastError ?? '同步失败，稍后会自动重试'
    default:
      break
  }
  if (status.lastSyncedAt) return `上次同步 ${relativeTime(status.lastSyncedAt, options.now)}`
  return '已配置 · 等待首次同步'
}

function relativeTime(timestamp: number, now = Date.now()): string {
  const diff = Math.max(0, now - timestamp)
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}
