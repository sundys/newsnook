/**
 * WebDAV 凭证保管。
 *
 * Android：密码明文只进 Keystore（与翻译 Key 同一套 SecureStore），
 * 普通存储里永远是空串，备份文件与调试工具都读不到。
 * Web：浏览器没有等价的安全存储，密码只留在当前页面的内存里，
 * 刷新后需要重新输入；这比把网盘密码写进 localStorage 更可接受。
 */

import { Capacitor } from '@capacitor/core'

import { getSecureStore, type SecureStore } from '../account/secureStore'
import { log } from '../../lib/logger'

export const WEBDAV_PASSWORD_KEY = 'webdav.password'

let runtimePassword = ''

/** 内存里的明文；`hydrateWebDavPassword` 之后才有值 */
export function getRuntimeWebDavPassword(): string {
  return runtimePassword
}

/** 仅供测试：清掉进程内缓存 */
export function resetWebDavPasswordForTests(): void {
  runtimePassword = ''
}

function passwordGoesToSecureStore(): boolean {
  return Capacitor.isNativePlatform()
}

export async function hydrateWebDavPassword(
  store: SecureStore = getSecureStore(),
): Promise<string> {
  if (!passwordGoesToSecureStore()) return runtimePassword
  try {
    runtimePassword = (await store.get(WEBDAV_PASSWORD_KEY)) ?? ''
  } catch (error) {
    log.sync.warn('webdav password hydrate failed', { error })
    runtimePassword = ''
  }
  return runtimePassword
}

/** 用户保存设置时调用；传空串等于清除 */
export async function persistWebDavPassword(
  password: string,
  store: SecureStore = getSecureStore(),
): Promise<void> {
  runtimePassword = password
  if (!passwordGoesToSecureStore()) return
  try {
    if (password) await store.set(WEBDAV_PASSWORD_KEY, password)
    else await store.remove(WEBDAV_PASSWORD_KEY)
  } catch (error) {
    log.sync.warn('webdav password persist failed', { error })
  }
}

export async function clearWebDavPassword(store: SecureStore = getSecureStore()): Promise<void> {
  await persistWebDavPassword('', store)
}
