import { CapacitorHttp } from '@capacitor/core'

import { isNewerVersion, normalizeTagVersion } from './semver'
import type { AppUpdateAbi, AppUpdateChannel, LatestReleaseInfo, UpdateCheckResult } from './types'

export type FetchReleaseApkResult =
  | { status: 'ok'; release: LatestReleaseInfo }
  | { status: 'no-asset'; version: string; channel: AppUpdateChannel; abi: AppUpdateAbi }
  | { status: 'error'; message: string }

export function buildApkFileName(
  version: string,
  channel: AppUpdateChannel,
  abi: AppUpdateAbi,
): string {
  return `newsnook-${version}-${channel}-${abi}-release.apk`
}

export function pickReleaseAsset(
  assets: { name: string; browser_download_url: string }[],
  version: string,
  channel: AppUpdateChannel,
  abi: AppUpdateAbi,
): { url: string; fileName: string } | null {
  const fileName = buildApkFileName(version, channel, abi)
  const hit = assets.find((a) => a.name === fileName)
  if (hit?.browser_download_url) return { url: hit.browser_download_url, fileName }

  // 兼容 fork 切换前仍保留旧命名的历史 Release。新发布必须使用 ABI 文件名。
  const legacyFileName = `newsnook-${version}-${channel}-release.apk`
  const legacyHit = assets.find((a) => a.name === legacyFileName)
  if (!legacyHit?.browser_download_url) return null
  return { url: legacyHit.browser_download_url, fileName: legacyFileName }
}

export function truncateReleaseNotes(body: string | null | undefined, maxLines = 8): string {
  const text = (body ?? '').trim()
  if (!text) return ''
  const lines = text.split(/\r?\n/)
  if (lines.length <= maxLines) return text
  return `${lines.slice(0, maxLines).join('\n')}\n…`
}

const RELEASES_LATEST = 'https://api.github.com/repos/sundys/newsnook/releases/latest'
const RELEASES_TAG_PREFIX = 'https://api.github.com/repos/sundys/newsnook/releases/tags/'

const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'NewsNook-AppUpdate',
}

export function releaseTagUrl(version: string): string {
  const normalized = normalizeTagVersion(version)
  return `https://github.com/sundys/newsnook/releases/tag/v${normalized}`
}

export type ReleaseNotesResult =
  | { status: 'ok'; version: string; tagName: string; body: string }
  | { status: 'empty'; version: string; tagName: string }
  | { status: 'error'; message: string }

/** 拉取指定版本（通常为当前 `__APP_VERSION__`）的 Release 说明 */
export async function fetchReleaseNotes(version: string): Promise<ReleaseNotesResult> {
  const normalized = normalizeTagVersion(version)
  if (!normalized) {
    return { status: 'error', message: '版本号无效' }
  }
  try {
    const response = await CapacitorHttp.get({
      url: `${RELEASES_TAG_PREFIX}v${encodeURIComponent(normalized)}`,
      headers: GITHUB_HEADERS,
    })
    if (response.status === 404) {
      return { status: 'error', message: '未找到该版本的发布说明' }
    }
    if (response.status < 200 || response.status >= 300) {
      return { status: 'error', message: `GitHub HTTP ${response.status}` }
    }
    const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data
    const tagName = String(data.tag_name ?? `v${normalized}`)
    const body = typeof data.body === 'string' ? data.body.trim() : ''
    if (!body) {
      return { status: 'empty', version: normalized, tagName }
    }
    return { status: 'ok', version: normalized, tagName, body }
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : '加载更新日志失败',
    }
  }
}

export async function fetchLatestRelease(
  localVersion: string,
  channel: AppUpdateChannel,
  abi: AppUpdateAbi,
): Promise<UpdateCheckResult> {
  try {
    const response = await CapacitorHttp.get({
      url: RELEASES_LATEST,
      headers: GITHUB_HEADERS,
    })
    if (response.status < 200 || response.status >= 300) {
      return { status: 'error', message: `GitHub HTTP ${response.status}` }
    }
    const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data
    const remoteVersion = normalizeTagVersion(String(data.tag_name ?? ''))
    if (!remoteVersion || !isNewerVersion(remoteVersion, localVersion)) {
      return {
        status: 'up-to-date',
        localVersion,
        remoteVersion: remoteVersion || localVersion,
      }
    }
    const picked = pickReleaseAsset(data.assets ?? [], remoteVersion, channel, abi)
    if (!picked) {
      return { status: 'no-asset', localVersion, remoteVersion, channel, abi }
    }
    return {
      status: 'available',
      localVersion,
      release: {
        version: remoteVersion,
        tagName: String(data.tag_name ?? ''),
        notes: truncateReleaseNotes(data.body),
        apkUrl: picked.url,
        apkFileName: picked.fileName,
        channel,
        abi,
      },
    }
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : '检查更新失败',
    }
  }
}

/** 从 tag Release JSON 解析指定渠道和 ABI 的 APK（不发起网络请求） */
export function releaseApkFromTagPayload(
  data: {
    tag_name?: unknown
    body?: unknown
    assets?: { name?: string; browser_download_url?: string }[]
  },
  version: string,
  channel: AppUpdateChannel,
  abi: AppUpdateAbi,
): FetchReleaseApkResult {
  const normalized = normalizeTagVersion(version)
  if (!normalized) return { status: 'error', message: '版本号无效' }
  const assets = (data.assets ?? [])
    .map((a) => ({
      name: String(a.name ?? ''),
      browser_download_url: String(a.browser_download_url ?? ''),
    }))
    .filter((a) => a.name && a.browser_download_url)
  const picked = pickReleaseAsset(assets, normalized, channel, abi)
  if (!picked) return { status: 'no-asset', version: normalized, channel, abi }
  return {
    status: 'ok',
    release: {
      version: normalized,
      tagName: String(data.tag_name ?? `v${normalized}`),
      notes: truncateReleaseNotes(typeof data.body === 'string' ? data.body : ''),
      apkUrl: picked.url,
      apkFileName: picked.fileName,
      channel,
      abi,
    },
  }
}

/** 拉取指定版本 Release 上某一渠道和 ABI 的 APK（同版本切换用，不与 latest 比较） */
export async function fetchReleaseApkForChannel(
  version: string,
  channel: AppUpdateChannel,
  abi: AppUpdateAbi,
): Promise<FetchReleaseApkResult> {
  const normalized = normalizeTagVersion(version)
  if (!normalized) return { status: 'error', message: '版本号无效' }
  try {
    const response = await CapacitorHttp.get({
      url: `${RELEASES_TAG_PREFIX}v${encodeURIComponent(normalized)}`,
      headers: GITHUB_HEADERS,
    })
    if (response.status === 404) {
      return { status: 'error', message: '未找到该版本的发布' }
    }
    if (response.status < 200 || response.status >= 300) {
      return { status: 'error', message: `GitHub HTTP ${response.status}` }
    }
    const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data
    return releaseApkFromTagPayload(data ?? {}, normalized, channel, abi)
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : '查找安装包失败',
    }
  }
}
