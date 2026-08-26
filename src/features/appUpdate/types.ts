export type AppUpdateChannel = 'cloud' | 'local'

/** GitHub Release 中按设备 ABI 拆分的 APK 产物。 */
export type AppUpdateAbi = 'arm64-v8a' | 'armeabi-v7a' | 'x86_64'

export type AppUpdatePrefs = {
  skippedVersion?: string
  snoozeUntil?: number
  lastCheckAt?: number
  availableVersion?: string
}

export type LatestReleaseInfo = {
  version: string
  tagName: string
  notes: string
  apkUrl: string
  apkFileName: string
  channel: AppUpdateChannel
  abi: AppUpdateAbi
}

export type UpdateCheckResult =
  | { status: 'up-to-date'; localVersion: string; remoteVersion: string }
  | { status: 'available'; localVersion: string; release: LatestReleaseInfo }
  | {
      status: 'no-asset'
      localVersion: string
      remoteVersion: string
      channel: AppUpdateChannel
      abi: AppUpdateAbi
    }
  | { status: 'error'; message: string }
