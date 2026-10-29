import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  CheckCircle2,
  CloudUpload,
  Eye,
  EyeOff,
  HardDrive,
  Info,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  XCircle,
} from 'lucide-react'

import { ConfirmDialog } from '../../components/ConfirmDialog'
import { SettingsHint, SettingsSection, SettingsShell } from '../../components/SettingsShell'
import { ToggleSwitch } from '../../components/ToggleSwitch'
import { WEBDAV_DIR_NAME, WEBDAV_FILE_NAME, normalizeWebDavUrl, webDavErrorMessage, WebDavError } from '../../features/webdav/client'
import { clearWebDavPassword, getRuntimeWebDavPassword, hydrateWebDavPassword, persistWebDavPassword } from '../../features/webdav/credentials'
import { isSameRound, preferNewerSide, webDavStatusCaption } from '../../features/webdav/state'
import type { WebDavDirection, WebDavSideSummary, WebDavStatus, WebDavSyncState } from '../../features/webdav/state'
import { readSyncSafetySnapshot, restoreSyncSafetySnapshot } from '../../lib/backup'
import { relativeTime } from '../../lib/time'

interface Props {
  state: WebDavSyncState
  status: WebDavStatus
  /** 配置变化后由父级递增，触发引擎重建与重连 */
  onStateChange: (patch: Partial<WebDavSyncState>) => void
  onTestConnection: () => Promise<void>
  onSyncNow: () => Promise<void>
  onResolve: (direction: WebDavDirection) => Promise<void>
  onDismissConflict: () => void
  onForceUpload: () => Promise<void>
  onForceDownload: () => Promise<void>
  onBack: () => void
}

const FIELD_LABEL = 'mb-1.5 block font-mono text-[10px] tracking-[0.16em] text-paper-faint'
const INPUT_WRAP =
  'flex min-h-12 items-center rounded-xl border border-haze bg-ink px-3.5 focus-within:border-cinnabar/55'
const INPUT =
  'min-w-0 flex-1 bg-transparent py-3 font-mono text-[13px] text-paper outline-none placeholder:text-paper-faint/65'
const CTA_BUTTON =
  'flex w-full items-center justify-center gap-2 rounded-xl border border-cinnabar/70 bg-cinnabar/15 px-4 py-3 text-[13.5px] font-medium text-cinnabar-soft transition-colors hover:bg-cinnabar/25 disabled:opacity-40'
const SECONDARY_BUTTON =
  'flex w-full items-center justify-center gap-2 rounded-xl border border-haze px-4 py-3 text-[13px] text-paper-muted transition-colors hover:text-paper disabled:opacity-40'

type TestState = 'idle' | 'testing' | 'ok' | 'error'

function sideLine(side: WebDavSideSummary): string {
  const parts: string[] = []
  if (side.enabledSourceCount) parts.push(`${side.enabledSourceCount} 个信源`)
  if (side.laterCount) parts.push(`${side.laterCount} 篇稍后读`)
  if (side.readCount) parts.push(`${side.readCount} 条已读`)
  if (side.readingPositionCount) parts.push(`${side.readingPositionCount} 条阅读位置`)
  return parts.length ? parts.join(' · ') : '仅配置'
}

function SideCard({
  title,
  side,
  highlight,
}: {
  title: string
  side: WebDavSideSummary
  highlight: boolean
}) {
  return (
    <div
      className={`rounded-2xl border p-3.5 ${
        highlight ? 'border-cinnabar/50 bg-cinnabar/5' : 'border-haze bg-ink-raised/60'
      }`}
    >
      <p className="text-[13.5px] font-medium text-paper">{title}</p>
      <p className="mt-1 font-mono text-[10.5px] text-paper-faint">
        {side.exportedAt ? `导出于 ${relativeTime(side.exportedAt)}` : '导出时间未知'}
        {side.appVersion ? ` · v${side.appVersion}` : ''}
      </p>
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-paper-muted">{sideLine(side)}</p>
    </div>
  )
}

/**
 * WebDAV 同步。
 *
 * 与「账户与云同步」的分工：这里没有账号、没有 NewsNook 服务端，
 * 配置整包放进用户自己的网盘目录 `newsnook/backup.json`。
 * 任何一步失败都只影响这一页，订阅浏览、正文抽取与离线缓存完全不依赖它。
 */
export function WebDavSyncScreen({
  state,
  status,
  onStateChange,
  onTestConnection,
  onSyncNow,
  onResolve,
  onDismissConflict,
  onForceUpload,
  onForceDownload,
  onBack,
}: Props) {
  const urlId = useId()
  const userInputId = useId()
  const passwordInputId = useId()

  const [baseUrl, setBaseUrl] = useState(state.baseUrl)
  const [username, setUsername] = useState(state.username)
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [test, setTest] = useState<TestState>('idle')
  const [testError, setTestError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'sync' | 'upload' | 'download' | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmDownload, setConfirmDownload] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [snapshotAt, setSnapshotAt] = useState<number | null>(
    () => readSyncSafetySnapshot()?.createdAt ?? null,
  )

  // 原生上密码从 Keystore 回填；Web 只能留空，由用户每次会话输入
  useEffect(() => {
    let active = true
    void hydrateWebDavPassword().then((value) => {
      if (active && value) setPassword(value)
    })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    setBaseUrl(state.baseUrl)
    setUsername(state.username)
  }, [state.baseUrl, state.username])

  const caption = webDavStatusCaption(status, { configured: Boolean(state.baseUrl) })

  const urlError = useMemo(() => {
    if (!baseUrl.trim()) return null
    try {
      normalizeWebDavUrl(baseUrl)
      return null
    } catch (error) {
      return error instanceof WebDavError ? error.message : '地址格式不正确'
    }
  }, [baseUrl])

  const savedPassword = getRuntimeWebDavPassword()
  const dirty =
    baseUrl.trim() !== state.baseUrl ||
    username.trim() !== state.username ||
    password !== savedPassword

  const saveAndConnect = useCallback(async () => {
    if (urlError) return
    setTest('testing')
    setTestError(null)
    setNotice(null)
    try {
      const { baseUrl: normalized } = normalizeWebDavUrl(baseUrl)
      await persistWebDavPassword(password)
      onStateChange({ baseUrl: normalized, username: username.trim() })
      await onTestConnection()
      setTest('ok')
    } catch (error) {
      setTest('error')
      setTestError(
        error instanceof WebDavError ? error.message : webDavErrorMessage('NETWORK'),
      )
    }
  }, [baseUrl, onStateChange, onTestConnection, password, urlError, username])

  const runSync = useCallback(async () => {
    setBusy('sync')
    setNotice(null)
    try {
      await onSyncNow()
      setNotice('同步完成')
      setSnapshotAt(readSyncSafetySnapshot()?.createdAt ?? null)
    } catch (error) {
      setTestError(error instanceof WebDavError ? error.message : '同步失败，请稍后重试')
    } finally {
      setBusy(null)
    }
  }, [onSyncNow])

  const runForceUpload = useCallback(async () => {
    setBusy('upload')
    try {
      await onForceUpload()
      setNotice('已用本机配置覆盖网盘')
    } catch (error) {
      setTestError(error instanceof WebDavError ? error.message : '上传失败，请稍后重试')
    } finally {
      setBusy(null)
    }
  }, [onForceUpload])

  const runForceDownload = useCallback(async () => {
    setConfirmDownload(false)
    setBusy('download')
    try {
      await onForceDownload()
      setSnapshotAt(readSyncSafetySnapshot()?.createdAt ?? null)
      setNotice('已用网盘配置覆盖本机')
    } catch (error) {
      setTestError(error instanceof WebDavError ? error.message : '下载失败，请稍后重试')
    } finally {
      setBusy(null)
    }
  }, [onForceDownload])

  const rollback = useCallback(async () => {
    const result = await restoreSyncSafetySnapshot()
    if (result) window.location.reload()
  }, [])

  const clearConfig = useCallback(async () => {
    setConfirmClear(false)
    await clearWebDavPassword()
    setPassword('')
    setBaseUrl('')
    setUsername('')
    setTest('idle')
    onStateChange({ baseUrl: '', username: '', autoSync: true })
  }, [onStateChange])

  const conflict = status.pendingConflict
  const preferred: WebDavDirection | null = conflict
    ? isSameRound(conflict.local.exportedAt, conflict.remote.exportedAt)
      ? null
      : preferNewerSide(conflict.local.exportedAt, conflict.remote.exportedAt)
    : null

  return (
    <SettingsShell title="同步（WebDAV）" caption={caption} onBack={onBack}>
      {!state.baseUrl && (
        <SettingsHint>
          用你自己的网盘（Nextcloud、群晖、坚果云等）同步配置，不经过任何 NewsNook
          服务器。填好地址与账号后，配置会存到网盘的 `{WEBDAV_DIR_NAME}/{WEBDAV_FILE_NAME}`。
        </SettingsHint>
      )}

      <SettingsSection title="服务器">
        <div className="page-x">
          <div className="mx-auto max-w-3xl space-y-4 rounded-2xl border border-haze bg-ink-raised p-5 shadow-[var(--shadow-lift)]">
            <label htmlFor={urlId} className="block">
              <span className={FIELD_LABEL}>WEBDAV 地址</span>
              <span className={`${INPUT_WRAP} ${urlError ? 'border-cinnabar/60' : ''}`}>
                <input
                  id={urlId}
                  type="url"
                  value={baseUrl}
                  placeholder="https://dav.example.com/remote.php/dav/files/me"
                  spellCheck={false}
                  autoCapitalize="none"
                  autoCorrect="off"
                  onChange={(event) => {
                    setBaseUrl(event.target.value)
                    setTest('idle')
                    setTestError(null)
                  }}
                  className={INPUT}
                />
              </span>
              {urlError && (
                <span className="mt-1.5 block text-[11px] text-cinnabar-soft">{urlError}</span>
              )}
            </label>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label htmlFor={userInputId} className="block">
                <span className={FIELD_LABEL}>账号</span>
                <span className={INPUT_WRAP}>
                  <input
                    id={userInputId}
                    type="text"
                    value={username}
                    placeholder="留空表示匿名访问"
                    spellCheck={false}
                    autoCapitalize="none"
                    autoCorrect="off"
                    onChange={(event) => {
                      setUsername(event.target.value)
                      setTest('idle')
                    }}
                    className={INPUT}
                  />
                </span>
              </label>

              <label htmlFor={passwordInputId} className="block">
                <span className={FIELD_LABEL}>密码</span>
                <span className={INPUT_WRAP}>
                  <input
                    id={passwordInputId}
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    placeholder="应用专用密码更安全"
                    autoCapitalize="none"
                    autoCorrect="off"
                    autoComplete="off"
                    onChange={(event) => {
                      setPassword(event.target.value)
                      setTest('idle')
                    }}
                    className={INPUT}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((prev) => !prev)}
                    aria-label={showPassword ? '隐藏密码' : '显示密码'}
                    className="ml-2 shrink-0 text-paper-faint hover:text-paper"
                  >
                    {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </span>
              </label>
            </div>

            <p className="flex items-start gap-2 text-[11px] leading-relaxed text-paper-faint">
              <ShieldCheck size={13} strokeWidth={1.7} className="mt-0.5 shrink-0" />
              <span className="min-w-0">
                密码只存在系统安全存储（Android Keystore），不进配置备份、不写日志。网页版只在当前页面内存中保留，刷新后需重新输入。
              </span>
            </p>

            <button
              type="button"
              disabled={test === 'testing' || Boolean(urlError) || !baseUrl.trim()}
              onClick={() => void saveAndConnect()}
              className={CTA_BUTTON}
            >
              {test === 'testing' ? (
                <LoaderCircle size={15} className="animate-spin" />
              ) : (
                <CloudUpload size={15} />
              )}
              {dirty ? '保存并测试连接' : '测试连接'}
            </button>

            {test === 'ok' && (
              <p className="flex items-center gap-1.5 font-mono text-[11px] text-emerald-500">
                <CheckCircle2 size={12} strokeWidth={2} />
                连接正常
              </p>
            )}
            {test === 'error' && testError && (
              <p className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-cinnabar-soft">
                <XCircle size={13} strokeWidth={1.8} className="mt-0.5 shrink-0" />
                <span className="min-w-0">{testError}</span>
              </p>
            )}
          </div>
        </div>
      </SettingsSection>

      {state.baseUrl && (
        <>
          <SettingsSection title="自动同步">
            <div className="page-x">
              <div className="flex items-center justify-between gap-4 rounded-2xl border border-haze bg-ink-raised p-4 shadow-[var(--shadow-lift)]">
                <div className="min-w-0 flex-1">
                  <span className="font-display text-[15px] font-medium text-paper">自动同步</span>
                  <p className="mt-1 text-[12px] leading-relaxed text-paper-muted">
                    改动后、回到前台、网络恢复时自动与网盘对齐。关掉后只保留手动同步。
                  </p>
                </div>
                <ToggleSwitch
                  checked={state.autoSync}
                  label="自动同步"
                  onChange={() => onStateChange({ autoSync: !state.autoSync })}
                />
              </div>
            </div>
          </SettingsSection>

          <SettingsSection title="同步状态">
            <div className="page-x space-y-3">
              <div className="rounded-2xl border border-haze bg-ink-raised p-4 shadow-[var(--shadow-lift)]">
                <div className="flex items-start gap-2">
                  {status.phase === 'syncing' ? (
                    <LoaderCircle size={14} className="mt-0.5 shrink-0 animate-spin text-paper-muted" />
                  ) : status.phase === 'error' || status.phase === 'conflict' ? (
                    <AlertTriangle size={14} className="mt-0.5 shrink-0 text-cinnabar-soft" />
                  ) : (
                    <Check size={14} className="mt-0.5 shrink-0 text-paper-faint" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-[13.5px] text-paper">{caption}</p>
                    <p className="mt-1 font-mono text-[10.5px] text-paper-faint">
                      {state.baseUrl}
                    </p>
                    {status.phase === 'error' && status.lastError && (
                      <p className="mt-1.5 text-[11.5px] leading-relaxed text-cinnabar-soft">
                        {status.lastError}
                      </p>
                    )}
                  </div>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void runSync()}
                    className={CTA_BUTTON}
                  >
                    {busy === 'sync' ? (
                      <LoaderCircle size={14} className="animate-spin" />
                    ) : (
                      <RefreshCw size={14} />
                    )}
                    立即同步
                  </button>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => setConfirmDownload(true)}
                    className={SECONDARY_BUTTON}
                  >
                    <ArrowDownToLine size={14} />
                    从网盘恢复
                  </button>
                </div>

                {notice && (
                  <p className="mt-2.5 flex items-center gap-1.5 font-mono text-[11px] text-paper-muted">
                    <Check size={12} strokeWidth={2} className="shrink-0 text-cinnabar-soft" />
                    {notice}
                  </p>
                )}
              </div>

              <div className="rounded-2xl border border-haze bg-ink-raised/60 p-4">
                <p className="flex items-center gap-1.5 text-[12.5px] font-medium text-paper">
                  <HardDrive size={14} strokeWidth={1.7} className="text-paper-muted" />
                  同步范围
                </p>
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-paper-muted">
                  偏好与自建订阅、场景预设、启用信源、稍后读、已读标记与阅读位置。
                  正文与列表缓存可再生，不进同步；它们也永远不会离开本机以外的任何地方。
                </p>
              </div>

              {snapshotAt && (
                <div className="rounded-2xl border border-haze bg-ink-raised/60 p-4">
                  <p className="flex items-center gap-1.5 text-[12.5px] font-medium text-paper">
                    <RotateCcw size={14} strokeWidth={1.7} className="text-paper-muted" />
                    同步前配置
                  </p>
                  <p className="mt-1.5 text-[11.5px] leading-relaxed text-paper-muted">
                    覆盖本机前自动留了一份快照（{relativeTime(snapshotAt)}）。
                  </p>
                  <button
                    type="button"
                    onClick={() => void rollback()}
                    className={`${SECONDARY_BUTTON} mt-3`}
                  >
                    恢复到这份快照
                  </button>
                </div>
              )}

              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void runForceUpload()}
                className={SECONDARY_BUTTON}
              >
                <ArrowUpFromLine size={14} />
                用本机配置覆盖网盘
              </button>

              <button
                type="button"
                onClick={() => setConfirmClear(true)}
                className="w-full rounded-xl border border-cinnabar/40 px-4 py-3 text-[13px] text-cinnabar-soft transition-colors hover:bg-cinnabar/10"
              >
                停止同步并清除配置
              </button>
            </div>
          </SettingsSection>
        </>
      )}

      <SettingsHint>
        不配置也能完整使用「有所闻」：订阅浏览、正文抽取与离线缓存都不依赖这里。
        {!state.baseUrl && ` 想用别的网盘？任何支持 WebDAV 的服务都可以，地址通常以 /dav 或 /remote.php/dav 结尾。`}
      </SettingsHint>

      {conflict && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          onClick={onDismissConflict}
        >
          <div
            className="flex max-h-[min(88vh,720px)] w-full max-w-lg flex-col rounded-3xl border border-haze bg-ink p-6 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start gap-2 border-b border-haze pb-4">
              <Info size={17} strokeWidth={1.7} className="mt-0.5 shrink-0 text-cinnabar-soft" />
              <div className="min-w-0">
                <h2 className="font-display text-[17px] font-medium text-paper">
                  本机与网盘都有改动
                </h2>
                <p className="mt-0.5 text-[11.5px] leading-relaxed text-paper-faint">
                  选择保留哪一份。未选中的那份会被覆盖，覆盖前会自动留一份本机快照。
                </p>
              </div>
            </div>

            <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto py-4">
              <SideCard
                title="本机"
                side={conflict.local}
                highlight={preferred === 'upload'}
              />
              <SideCard
                title="网盘"
                side={conflict.remote}
                highlight={preferred === 'download'}
              />
              <p className="text-[11px] leading-relaxed text-paper-faint">
                {preferred
                  ? `按导出时间，${preferred === 'upload' ? '本机' : '网盘'}那份更新一些。`
                  : '两份导出时间接近，建议先看看各自的条目数量再决定。'}
              </p>
            </div>

            <div className="flex flex-col gap-2 border-t border-haze pt-4">
              <button
                type="button"
                onClick={() => void onResolve('upload')}
                className={preferred === 'upload' ? CTA_BUTTON : SECONDARY_BUTTON}
              >
                <ArrowUpFromLine size={14} />
                保留本机，覆盖网盘
              </button>
              <button
                type="button"
                onClick={() => void onResolve('download')}
                className={preferred === 'download' ? CTA_BUTTON : SECONDARY_BUTTON}
              >
                <ArrowDownToLine size={14} />
                保留网盘，覆盖本机
              </button>
              <button
                type="button"
                onClick={onDismissConflict}
                className="mt-1 font-mono text-[11px] text-paper-faint hover:text-paper"
              >
                稍后再说
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmDownload}
        title="用网盘配置覆盖本机？"
        message="本机的订阅、分类、应用配置、稍后读、已读与阅读位置都会换成网盘那一份。覆盖前会自动留一份本机快照，之后可以恢复。"
        confirmLabel="覆盖本机"
        cancelLabel="取消"
        onConfirm={() => void runForceDownload()}
        onCancel={() => setConfirmDownload(false)}
      />

      <ConfirmDialog
        open={confirmClear}
        title="停止 WebDAV 同步？"
        message="只清掉这台设备保存的地址、账号与密码，网盘上的文件与本机配置都会保留。"
        confirmLabel="停止同步"
        cancelLabel="取消"
        onConfirm={() => void clearConfig()}
        onCancel={() => setConfirmClear(false)}
      />
    </SettingsShell>
  )
}
