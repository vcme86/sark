/**
 * Reverse proxy IP resolution, external origin recovery, and Host validation.
 *
 * @module
 */

import {
  convertIPv4MappedIPv6ToIPv4,
  convertIPv4ToBinary,
  convertIPv6ToBinary,
  distinctRemoteAddr,
  isIPv4MappedIPv6,
} from 'hono/utils/ipaddr'

import { HttpError } from './error'

const LOOPBACK_RANGES = ['127.0.0.0/8', '::1/128', '::ffff:127.0.0.0/104']
const PRIVATE_RANGES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7', 'fe80::/10']

interface CompiledCidr {
  readonly isIPv4: boolean
  readonly mask: bigint
  readonly expected: bigint
}

interface CompiledExactIp {
  readonly isIPv4: boolean
  readonly binary: bigint
}

export interface CompiledProxyRules {
  readonly staticExact: readonly CompiledExactIp[]
  readonly cidrs: readonly CompiledCidr[]
}

function parseCidrRule(rule: string): CompiledCidr | null {
  const [addrStr, prefixStr, extra] = rule.split('/')
  if (!addrStr || !prefixStr || extra !== undefined || !/^\d+$/.test(prefixStr)) return null
  const type = distinctRemoteAddr(addrStr)
  if (!type) return null

  let isIPv4 = type === 'IPv4'
  let prefix = Number(prefixStr)
  if (Number.isNaN(prefix) || prefix < 0) return null

  let addr = isIPv4 ? convertIPv4ToBinary(addrStr) : convertIPv6ToBinary(addrStr)
  if (!isIPv4 && isIPv4MappedIPv6(addr) && prefix >= 96) {
    isIPv4 = true
    addr = convertIPv4MappedIPv6ToIPv4(addr)
    prefix -= 96
  }

  const maxBits = isIPv4 ? 32 : 128
  if (prefix > maxBits) return null

  const mask = ((1n << BigInt(prefix)) - 1n) << BigInt(maxBits - prefix)
  const expected = addr & mask
  return { isIPv4, mask, expected }
}

function parseExactIpRule(rule: string): CompiledExactIp | null {
  const type = distinctRemoteAddr(rule)
  if (!type) return null
  const isIPv4 = type === 'IPv4'
  const binary = isIPv4 ? convertIPv4ToBinary(rule) : convertIPv6ToBinary(rule)
  return { isIPv4, binary }
}

/**
 * Compiles trusted proxy descriptors into binary matchers.
 *
 * @param rules - Array of `'loopback'`, `'private'`, exact IP addresses, or CIDR blocks.
 * @returns Precompiled rules for rapid matching across request hops.
 * @throws If a trusted proxy descriptor is not a supported keyword, IP address or CIDR.
 */
export function compileProxyRules(
  rules: ReadonlyArray<'loopback' | 'private' | string>,
): CompiledProxyRules {
  const staticExact: CompiledExactIp[] = []
  const cidrs: CompiledCidr[] = []

  const rawCidrs: string[] = []
  for (const rule of rules) {
    if (rule === 'loopback') {
      rawCidrs.push(...LOOPBACK_RANGES)
    } else if (rule === 'private') {
      rawCidrs.push(...PRIVATE_RANGES)
    } else if (rule.includes('/')) {
      rawCidrs.push(rule)
    } else {
      const exact = parseExactIpRule(rule)
      if (!exact) throw new Error(`http.trustedProxies contains an invalid address: ${rule}`)
      staticExact.push(exact)
    }
  }

  for (const cidr of rawCidrs) {
    const compiled = parseCidrRule(cidr)
    if (!compiled) throw new Error(`http.trustedProxies contains an invalid CIDR: ${cidr}`)
    cidrs.push(compiled)
  }

  return { staticExact, cidrs }
}

/**
 * Checks whether an IP address matches precompiled trusted proxy rules.
 *
 * @param ip - Candidate IP address string.
 * @param compiled - Precompiled proxy rules.
 * @returns `true` if the candidate matches a trusted proxy rule.
 */
export function matchesCompiledRules(ip: string, compiled: CompiledProxyRules): boolean {
  if (!ip) return false
  const cleanIp = ip.trim()
  const type = distinctRemoteAddr(cleanIp)
  if (!type) return false

  const isIPv4 = type === 'IPv4'
  const addr = isIPv4 ? convertIPv4ToBinary(cleanIp) : convertIPv6ToBinary(cleanIp)
  const mappedV4 = !isIPv4 && isIPv4MappedIPv6(addr) ? convertIPv4MappedIPv6ToIPv4(addr) : null

  for (const exact of compiled.staticExact) {
    if (exact.isIPv4) {
      if (isIPv4 && addr === exact.binary) return true
      if (mappedV4 !== null && mappedV4 === exact.binary) return true
    } else {
      if (!isIPv4 && addr === exact.binary) return true
    }
  }

  for (const cidr of compiled.cidrs) {
    if (cidr.isIPv4) {
      if (isIPv4 && (addr & cidr.mask) === cidr.expected) return true
      if (mappedV4 !== null && (mappedV4 & cidr.mask) === cidr.expected) return true
    } else {
      if (!isIPv4 && (addr & cidr.mask) === cidr.expected) return true
    }
  }

  return false
}

/**
 * Checks whether an IP address matches any of the configured trusted proxy descriptors.
 *
 * @param ip - Candidate IP address string.
 * @param trustedProxies - List of trusted proxy rules (`'loopback'`, `'private'`, exact IP, or CIDR).
 * @returns `true` if the IP address matches a trusted proxy rule.
 */
export function isTrustedProxy(
  ip: string,
  trustedProxies: ReadonlyArray<'loopback' | 'private' | string>,
): boolean {
  if (!ip || trustedProxies.length === 0) return false
  return matchesCompiledRules(ip, compileProxyRules(trustedProxies))
}

/**
 * Resolves the client address by traversing X-Forwarded-For across trusted proxies.
 *
 * Invariants:
 * 1. Direct socket peer address is the starting point.
 * 2. If the peer address is not in `trustedProxies`, `X-Forwarded-For` is completely ignored.
 * 3. If peer is trusted, hops are scanned right-to-left until the first untrusted IP is reached.
 *
 * @param headers - Request headers object.
 * @param peerIp - Immediate socket connection remote address.
 * @param trustedRules - Proxy rules compiled at the owning configuration boundary.
 * @returns Resolved client IP address string.
 */
export function resolveClientIp(
  headers: Headers,
  peerIp: string,
  trustedRules: CompiledProxyRules,
): string {
  if (!matchesCompiledRules(peerIp, trustedRules)) {
    return peerIp
  }

  const xff = headers.get('x-forwarded-for')
  if (!xff || xff.trim() === '') {
    return peerIp
  }

  const hops = xff
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)

  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i]
    if (!matchesCompiledRules(hop, trustedRules)) {
      return hop
    }
  }

  return hops[0] || peerIp
}

/**
 * Recovers the external client-facing origin URL from reverse proxy headers if the peer is trusted.
 *
 * @param requestUrl - Target request URL.
 * @param headers - Incoming request headers.
 * @param peerIp - Immediate socket connection remote address.
 * @param trustedRules - Proxy rules compiled at the owning configuration boundary.
 * @returns Fully resolved external origin URL.
 */
export function resolveExternalOrigin(
  requestUrl: URL,
  headers: Headers,
  peerIp: string,
  trustedRules: CompiledProxyRules,
): URL {
  if (!matchesCompiledRules(peerIp, trustedRules)) {
    return new URL(requestUrl.origin)
  }

  const rawProto = headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  const rawHost = headers.get('x-forwarded-host')?.split(',')[0]?.trim() || headers.get('host')
  const rawPort = headers.get('x-forwarded-port')?.split(',')[0]?.trim()

  const proto = rawProto
    ? rawProto.endsWith(':')
      ? rawProto
      : `${rawProto}:`
    : requestUrl.protocol

  let host = rawHost || requestUrl.host

  if (host && rawPort) {
    const hasPort = host.startsWith('[')
      ? host.slice(host.indexOf(']')).includes(':')
      : host.includes(':')
    if (!hasPort) {
      const isStandard =
        (proto === 'http:' && rawPort === '80') || (proto === 'https:' && rawPort === '443')
      if (!isStandard) {
        host = `${host}:${rawPort}`
      }
    }
  }

  try {
    return new URL(`${proto}//${host}`)
  } catch {
    return new URL(requestUrl.origin)
  }
}

/**
 * Validates the incoming Host header against allowed host configurations.
 *
 * @param hostHeader - Host header value to validate, including an optional port.
 * @param allowedHosts - Configured host whitelist or undefined if unconstrained.
 * @throws {HttpError} 400 Bad Request if the host does not match allowed patterns.
 */
export function validateHost(
  hostHeader: string | null | undefined,
  allowedHosts?: string | readonly string[],
): void {
  if (!allowedHosts) return
  const hosts = typeof allowedHosts === 'string' ? [allowedHosts] : allowedHosts
  if (hosts.length === 0) return

  const raw = (hostHeader || '').trim()
  if (!raw) {
    throw new HttpError(400, 'Invalid Host header', { code: 'invalid_host' })
  }

  let candidate: string
  if (raw.startsWith('[')) {
    const closing = raw.indexOf(']')
    candidate = (closing !== -1 ? raw.slice(0, closing + 1) : raw).toLowerCase()
  } else {
    candidate = raw.split(':')[0].trim().toLowerCase()
  }

  if (!candidate) {
    throw new HttpError(400, 'Invalid Host header', { code: 'invalid_host' })
  }

  for (const pattern of hosts) {
    const cleanPattern = pattern.trim().toLowerCase()
    if (cleanPattern.startsWith('*.')) {
      const suffix = cleanPattern.slice(1) // e.g. '.example.com'
      if (candidate.endsWith(suffix) && candidate.length > suffix.length) {
        return
      }
    } else if (cleanPattern === candidate) {
      return
    }
  }

  throw new HttpError(400, `Host "${candidate}" is not permitted`, { code: 'invalid_host' })
}
