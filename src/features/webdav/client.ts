/**
 * 极简 WebDAV 客户端：只实现同步需要的那几个动词。
 *
 * 目标是把配置备份整包放进用户自己的网盘（Nextcloud / 群晖 / 坚果云 / Alist …），
 * 不引入第三方依赖、不依赖任何 NewsNook 服务端。
 *
 * 传输分环境：
 * - Android：ProxiedHttp 原生桥（可带用户代理隧道、可发自定义动词）
 * - Web：`fetch`（同源 CORS 由网盘服务端决定，失败就明确提示）
 *
 * 凭证只在内存与 Keystore 里，日志里永不出现明文。
 */

import { Capacitor } from '@capacitor/core'

import { decodeBase64ToArrayBuffer, nativeProxiedRequest } from '../proxy/nativeHttp'
import { currentProxyRuntime } from '../proxy/runtime'
import { resolveProxyTransport } from '../proxy/transport'
import { getRuntimeProxyPrefs } from '../../lib/http'
import { log } from '../../lib/logger'

/** 同步文件固定落在用户填写的目录下，避免污染网盘根目录 */
export const WEBDAV_DIR_NAME = 'newsnook'
export const WEBDAV_FILE_NAME = 'backup.json'

export type WebDavAuthMode = 'basic'

/**
 * 权限检查与创建目录共用一次 PROPFIND 结果：
 * 有些网盘对不存在的路径返回 403 而不是 404，直接报「没有写入权限」会误导用户。
 */
export interface WebDavDirCheck {
  exists: boolean
  /** 目录不存在、但服务器明确表示没有创建权限 */
  forbidden: boolean
}

export interface WebDavConfig {
  /** 用户填写的根地址，例如 https://dav.example.com/remote.php/dav/files/me */
  baseUrl: string
  username: string
  /** 明文只在内存 / Keystore；落普通存储时为空串 */
  password: string
  authMode: WebDavAuthMode
}

export interface WebDavResponse {
  status: number
  headers: Record<string, string>
  text: string
}

/** 传输层错误：带上可读中文与是否可重试，供同步状态机判断 */
export class WebDavError extends Error {
  readonly code: WebDavErrorCode
  constructor(code: WebDavErrorCode, message: string) {
    super(message)
    this.name = 'WebDavError'
    this.code = code
  }
}

export type WebDavErrorCode =
  | 'INVALID_URL'
  | 'AUTH_REQUIRED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'FORBIDDEN'
  | 'NETWORK'
  | 'SERVER'
  | 'NOT_DAV'

function basicAuthHeader(username: string, password: string): string {
  // btoa 只吃 latin1：先按 UTF-8 编字节再转 base64，中文用户名才不会被截断
  const bytes = new TextEncoder().encode(`${username}:${password}`)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `Basic ${btoa(binary)}`
}

/**
 * 规范化用户填写的地址：去尾斜杠、拒绝非 http(s) 与带查询串的地址。
 * 允许带 basic 认证信息的老式写法（`https://user:pass@host/dav`）会被拆出来，
 * 但调用方优先使用单独保存的账号密码。
 */
export function normalizeWebDavUrl(raw: string): { baseUrl: string; embeddedAuth?: { username: string; password: string } } {
  const trimmed = raw.trim()
  if (!trimmed) throw new WebDavError('INVALID_URL', '请填写 WebDAV 地址')

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new WebDavError('INVALID_URL', 'WebDAV 地址格式不正确，需要以 http:// 或 https:// 开头')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new WebDavError('INVALID_URL', 'WebDAV 地址只支持 http:// 或 https://')
  }

  const embeddedAuth =
    parsed.username || parsed.password
      ? {
          username: decodeURIComponent(parsed.username),
          password: decodeURIComponent(parsed.password),
        }
      : undefined

  parsed.username = ''
  parsed.password = ''
  parsed.hash = ''
  const baseUrl = parsed.href.replace(/\/+$/, '')
  return { baseUrl, ...(embeddedAuth ? { embeddedAuth } : {}) }
}

export function webDavDirectoryUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${WEBDAV_DIR_NAME}`
}

export function webDavFileUrl(baseUrl: string): string {
  return `${webDavDirectoryUrl(baseUrl)}/${WEBDAV_FILE_NAME}`
}

/** 账号密码为空时仍允许匿名 / 已带凭证的地址，但不发 Authorization 头 */
export function authHeaderFor(config: WebDavConfig): Record<string, string> {
  if (!config.username && !config.password) return {}
  return { Authorization: basicAuthHeader(config.username, config.password) }
}

function headerOf(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value
  }
  return undefined
}

function classifyStatus(status: number): WebDavErrorCode | null {
  if (status === 401) return 'AUTH_REQUIRED'
  if (status === 403) return 'FORBIDDEN'
  if (status === 404) return 'NOT_FOUND'
  if (status === 409) return 'CONFLICT'
  if (status === 405 || status === 501) return 'NOT_DAV'
  if (status >= 500) return 'SERVER'
  return null
}

const STATUS_TEXT: Record<WebDavErrorCode, string> = {
  INVALID_URL: '地址无效',
  AUTH_REQUIRED: '账号或密码不正确',
  NOT_FOUND: '网盘上还没有这份同步文件',
  CONFLICT: '网盘上的目录结构有冲突',
  FORBIDDEN: '这个账号没有写入权限',
  NETWORK: '连不上 WebDAV 服务器',
  SERVER: 'WebDAV 服务器出错了',
  NOT_DAV: '该地址不支持 WebDAV 请求',
}

export function webDavErrorMessage(code: WebDavErrorCode, detail?: string): string {
  const base = STATUS_TEXT[code]
  return detail ? `${base}（${detail}）` : base
}

export interface WebDavRequest {
  method: string
  url: string
  headers?: Record<string, string>
  body?: string
  /** 只关心状态码与头（HEAD / PROPFIND 深度 0） */
  timeoutMs?: number
}

async function requestViaNative(request: WebDavRequest): Promise<WebDavResponse> {
  // WebDAV 是用户自己的服务，不走「智能分流」判定：只有显式全局代理才套隧道，
  // 否则会把局域网网盘（192.168.x.x）误送去境外代理。
  const prefs = getRuntimeProxyPrefs()
  const transport =
    prefs.mode === 'always'
      ? resolveProxyTransport(request.url, undefined, prefs, currentProxyRuntime())
      : undefined
  const tunnel = transport?.kind === 'native-tunnel' ? transport.tunnel : undefined

  const response = await nativeProxiedRequest({
    url: request.url,
    method: request.method,
    headers: request.headers,
    ...(request.body !== undefined ? { data: request.body } : {}),
    proxy: tunnel,
    followRedirects: false,
    connectTimeout: 15000,
    readTimeout: request.timeoutMs ?? 25000,
  })

  const bytes = decodeBase64ToArrayBuffer(response.data)
  const text = new TextDecoder().decode(bytes)
  return { status: response.status, headers: response.headers, text }
}

async function requestViaFetch(request: WebDavRequest): Promise<WebDavResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 25000)
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
      // 不跟随重定向：网盘常把 http 跳到 https，跟随会丢掉自定义动词
      redirect: 'manual',
      credentials: 'omit',
    })
    const headers: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      headers[key] = value
    })
    return { status: response.status, headers, text: await response.text() }
  } finally {
    clearTimeout(timer)
  }
}

/** 所有 WebDAV 请求的唯一出口；网络异常统一转成 WebDavError */
export async function webDavRequest(request: WebDavRequest): Promise<WebDavResponse> {
  try {
    return Capacitor.isNativePlatform()
      ? await requestViaNative(request)
      : await requestViaFetch(request)
  } catch (error) {
    // 凭证绝不进日志：只记动词与主机名
    log.sync.warn('webdav request failed', {
      method: request.method,
      host: safeHost(request.url),
      error: error instanceof Error ? error.name : typeof error,
    })
    if (error instanceof WebDavError) throw error
    throw new WebDavError('NETWORK', STATUS_TEXT.NETWORK)
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'invalid'
  }
}

export function assertStatus(
  response: WebDavResponse,
  allowed: number[],
  context: string,
): WebDavResponse {
  if (allowed.includes(response.status)) return response
  const code = classifyStatus(response.status)
  if (code) {
    throw new WebDavError(code, webDavErrorMessage(code, `${context} · HTTP ${response.status}`))
  }
  throw new WebDavError('SERVER', `${context} 失败（HTTP ${response.status}）`)
}

/** 只问「在不在」：PROPFIND 深度 0 拿 200/207 都算存在 */
export async function webDavProbe(url: string, config: WebDavConfig): Promise<WebDavDirCheck> {
  const response = await webDavRequest({
    method: 'PROPFIND',
    url,
    headers: {
      ...authHeaderFor(config),
      Depth: '0',
      'Content-Type': 'application/xml; charset=utf-8',
    },
    body:
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>',
    timeoutMs: 15000,
  })
  if (response.status === 404) return { exists: false, forbidden: false }
  // 部分网盘（含只读共享）对不存在的子路径返回 403：那是权限问题，不是「目录还没建」
  if (response.status === 403) return { exists: false, forbidden: true }
  assertStatus(response, [200, 207], '检查网盘目录')
  return { exists: true, forbidden: false }
}

/** 确保 `newsnook/` 目录存在；已存在（405）视为成功 */
export async function webDavEnsureDirectory(config: WebDavConfig): Promise<void> {
  const dirUrl = webDavDirectoryUrl(config.baseUrl)
  const check = await webDavProbe(dirUrl, config)
  if (check.exists) return
  if (check.forbidden) {
    throw new WebDavError('FORBIDDEN', webDavErrorMessage('FORBIDDEN', '无法访问同步目录'))
  }

  const response = await webDavRequest({
    method: 'MKCOL',
    url: dirUrl,
    headers: authHeaderFor(config),
  })
  // 405 = 已存在；409 = 上级目录不在（用户填的根地址本身无效）
  if (response.status === 201 || response.status === 405 || response.status === 200) return
  assertStatus(response, [201, 200, 405], '创建同步目录')
}

export interface WebDavRemoteFile {
  exists: boolean
  /** 服务端声明的修改时间（毫秒），拿不到就是 null */
  lastModified: number | null
  text: string
}

function parseHttpDate(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** 读取网盘上的同步文件；不存在返回 exists=false，而不是抛错 */
export async function webDavDownload(config: WebDavConfig): Promise<WebDavRemoteFile> {
  const response = await webDavRequest({
    method: 'GET',
    url: webDavFileUrl(config.baseUrl),
    headers: { ...authHeaderFor(config), Accept: 'application/json' },
  })
  if (response.status === 404) return { exists: false, lastModified: null, text: '' }
  assertStatus(response, [200], '读取同步文件')
  return {
    exists: true,
    lastModified: parseHttpDate(headerOf(response.headers, 'last-modified')),
    text: response.text,
  }
}

/** 上传整包；返回服务端 ack 的 ETag（可能为空） */
export async function webDavUpload(config: WebDavConfig, text: string): Promise<string | null> {
  const response = await webDavRequest({
    method: 'PUT',
    url: webDavFileUrl(config.baseUrl),
    headers: {
      ...authHeaderFor(config),
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: text,
  })
  assertStatus(response, [200, 201, 204], '上传同步文件')
  return headerOf(response.headers, 'etag') ?? null
}

/** 连通性检查：地址 + 凭证 + 能否建目录，三步都过才算可用 */
export async function webDavCheckConnection(config: WebDavConfig): Promise<void> {
  await webDavEnsureDirectory(config)
  const probe = await webDavRequest({
    method: 'PROPFIND',
    url: webDavDirectoryUrl(config.baseUrl),
    headers: { ...authHeaderFor(config), Depth: '0' },
    timeoutMs: 15000,
  })
  assertStatus(probe, [200, 207], '验证同步目录')
}
