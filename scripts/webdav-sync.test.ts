/**
 * WebDAV 同步的纯逻辑层：地址规范化、认证头、方向判定、冲突倾向、状态文案。
 * 全部是纯函数断言，不发真实网络请求。
 * 运行：npm run test:webdav-sync
 */
import assert from 'node:assert/strict'

import {
  authHeaderFor,
  normalizeWebDavUrl,
  webDavDirectoryUrl,
  webDavFileUrl,
  webDavErrorMessage,
  WebDavError,
  type WebDavConfig,
} from '../src/features/webdav/client'
import {
  DEFAULT_WEBDAV_STATE,
  backupContentKey,
  decideWebDavSync,
  describeAction,
  isSameRound,
  isWebDavConfigured,
  normalizeWebDavState,
  preferNewerSide,
  summarizeSide,
  webDavStatusCaption,
  type WebDavSyncState,
} from '../src/features/webdav/state'
import type { BackupPayload } from '../src/lib/backup'

function payload(exportedAt: number, data: BackupPayload['data'] = {}): BackupPayload {
  return { format: 'newsnook-backup', version: 1, exportedAt, data }
}

function state(patch: Partial<WebDavSyncState> = {}): WebDavSyncState {
  return { ...DEFAULT_WEBDAV_STATE, ...patch }
}

// ---------- 地址 ----------

assert.deepEqual(normalizeWebDavUrl('  https://dav.example.com/remote.php/dav/files/me/  '), {
  baseUrl: 'https://dav.example.com/remote.php/dav/files/me',
})
assert.equal(
  webDavDirectoryUrl('https://dav.example.com/dav/'),
  'https://dav.example.com/dav/newsnook',
)
assert.equal(
  webDavFileUrl('https://dav.example.com/dav'),
  'https://dav.example.com/dav/newsnook/backup.json',
)

// 地址里内嵌的账号密码被拆出来，不进 baseUrl（避免落到日志与备份里）
const embedded = normalizeWebDavUrl('https://me:p%40ss@dav.example.com/dav')
assert.equal(embedded.baseUrl, 'https://dav.example.com/dav')
assert.deepEqual(embedded.embeddedAuth, { username: 'me', password: 'p@ss' })

for (const bad of ['', '   ', 'ftp://dav.example.com', 'not a url']) {
  assert.throws(() => normalizeWebDavUrl(bad), WebDavError, `应拒绝地址: ${bad}`)
}
assert.equal(
  (() => {
    try {
      normalizeWebDavUrl('ftp://dav.example.com')
    } catch (error) {
      return (error as WebDavError).code
    }
    return ''
  })(),
  'INVALID_URL',
)

// ---------- 认证头 ----------

const config: WebDavConfig = {
  baseUrl: 'https://dav.example.com/dav',
  username: 'me',
  password: 'secret',
  authMode: 'basic',
}
assert.equal(authHeaderFor(config).Authorization, `Basic ${Buffer.from('me:secret').toString('base64')}`)
// 中文用户名按 UTF-8 编码，不能被 btoa 截断
const cn = authHeaderFor({ ...config, username: '用户', password: '密码' })
assert.equal(cn.Authorization, `Basic ${Buffer.from('用户:密码', 'utf8').toString('base64')}`)
// 匿名访问不发 Authorization 头
assert.deepEqual(authHeaderFor({ ...config, username: '', password: '' }), {})

// ---------- 错误文案 ----------

assert.match(webDavErrorMessage('AUTH_REQUIRED'), /账号或密码/)
assert.match(webDavErrorMessage('NOT_FOUND', 'HTTP 404'), /HTTP 404/)
assert.match(webDavErrorMessage('NOT_DAV'), /不支持 WebDAV/)

// ---------- 状态归一化 ----------

assert.deepEqual(normalizeWebDavState(null), DEFAULT_WEBDAV_STATE)
assert.equal(normalizeWebDavState({ baseUrl: ' https://x/dav ', username: 42 }).username, '')
assert.equal(normalizeWebDavState({ baseUrl: 'https://x/dav' }).autoSync, true, '缺省视为开启')
assert.equal(normalizeWebDavState({ baseUrl: 'https://x/dav', autoSync: false }).autoSync, false)
assert.equal(isWebDavConfigured(state()), false)
assert.equal(isWebDavConfigured(state({ baseUrl: 'https://x/dav' })), true)
assert.equal(isWebDavConfigured(state({ baseUrl: '   ' })), false)

// ---------- 方向判定 ----------

const base = state({ baseUrl: 'https://x/dav', localFingerprint: 'L0', remoteFingerprint: 'R0' })

assert.equal(
  decideWebDavSync({ localFingerprint: 'L0', remoteFingerprint: '', state: base, remoteExists: false }),
  'upload-initial',
  '网盘上没有文件时直接把本机传上去',
)
assert.equal(
  decideWebDavSync({ localFingerprint: 'L0', remoteFingerprint: 'L0', state: base, remoteExists: true }),
  'up-to-date',
)
assert.equal(
  decideWebDavSync({ localFingerprint: 'L1', remoteFingerprint: 'R0', state: base, remoteExists: true }),
  'upload',
  '只有本机变了：上传',
)
assert.equal(
  decideWebDavSync({ localFingerprint: 'L0', remoteFingerprint: 'R1', state: base, remoteExists: true }),
  'download',
  '只有网盘变了：下载',
)
assert.equal(
  decideWebDavSync({ localFingerprint: 'L1', remoteFingerprint: 'R1', state: base, remoteExists: true }),
  'conflict',
  '两边都变了：必须让用户裁决',
)
assert.equal(
  decideWebDavSync({
    localFingerprint: 'L1',
    remoteFingerprint: 'R1',
    state: state({ baseUrl: 'https://x/dav' }),
    remoteExists: true,
  }),
  'unknown-baseline',
  '没有基线时不能自动覆盖任何一边',
)

// ---------- 冲突倾向 ----------

assert.equal(preferNewerSide(1000, 2000), 'download')
assert.equal(preferNewerSide(2000, 1000), 'upload')
assert.equal(preferNewerSide(1000, 1000), 'upload', '完全相同的时间不构成冲突，退化为上传')
assert.equal(isSameRound(1000, 1000 + 30_000), true)
assert.equal(isSameRound(1000, 1000 + 5 * 60_000), false)

// ---------- 内容指纹口径 ----------

const left = payload(1000, { enabledSources: ['a'] })
const right = payload(9999, { enabledSources: ['a'] })
assert.deepEqual(
  backupContentKey(left),
  backupContentKey(right),
  '只有导出时间不同不算改动',
)
assert.notDeepEqual(backupContentKey(left), backupContentKey(payload(1000, { enabledSources: ['b'] })))

// ---------- 摘要 ----------

const summary = summarizeSide(
  payload(1234, {
    preferences: { theme: 'dark' },
    presets: {},
    enabledSources: ['a', 'b'],
    laterItems: [{ id: 'x', title: 't' } as never],
    readIds: ['r1', 'r2', 'r3'],
    readingPositions: { x: { scrollTop: 100, updatedAt: 1 } },
  }),
)
assert.equal(summary.enabledSourceCount, 2)
assert.equal(summary.laterCount, 1)
assert.equal(summary.readCount, 3)
assert.equal(summary.readingPositionCount, 1)
assert.equal(summary.hasPreferences, true)

// ---------- 文案 ----------

assert.match(webDavStatusCaption({ phase: 'idle', lastSyncedAt: null, lastError: null, pendingConflict: null }, { configured: false }), /未配置/)
assert.equal(
  webDavStatusCaption({ phase: 'idle', lastSyncedAt: null, lastError: null, pendingConflict: null }, { configured: true }),
  '已配置 · 等待首次同步',
)
assert.equal(
  webDavStatusCaption({ phase: 'conflict', lastSyncedAt: 1, lastError: null, pendingConflict: null }, { configured: true }),
  '本机与网盘不一致 · 等待选择',
)
assert.match(describeAction('download'), /从网盘恢复/)
assert.match(describeAction('conflict'), /需要选择/)

console.log('webdav sync: ok')
