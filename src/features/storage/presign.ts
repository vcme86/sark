/** Optional object storage signing capability using the AWS SDK. */
import {
  type PresignConfig,
  type PresignDeclaration,
  resolvePresignRequest,
  type S3PresignConfig,
} from './presign-config'
import { encodeStorageKey } from './types'

export type {
  PresignConfig,
  PresignDeclaration,
  R2PresignConfig,
  S3PresignConfig,
} from './presign-config'

/**
 * Declares S3 presigning with the default URL lifetime.
 *
 * @returns A declaration that reuses the parent S3 storage configuration.
 */
export function definePresign(): PresignDeclaration<S3PresignConfig>

/**
 * Declares presigned upload and download URLs for the selected storage backend.
 *
 * @param options - Backend-specific signing settings; S3 reuses its storage configuration.
 * @returns A signing capability declaration retaining the supplied options.
 */
export function definePresign<const Options extends PresignConfig>(
  options: Options,
): PresignDeclaration<Options>
export function definePresign(options: PresignConfig = {}): PresignDeclaration {
  return {
    kind: 'presign',
    options,
    async createR2Signer(config) {
      // Ordinary R2 imports only configuration types and validators. The selected
      // capability awaits its SDK imports so initialization failures reach the owner.
      const [{ S3RequestPresigner }, { Sha256 }] = await Promise.all([
        import('@aws-sdk/s3-request-presigner'),
        import('@aws-sdk/checksums/sha'),
      ])
      const signer = new S3RequestPresigner({
        region: config.region,
        credentials: config.credentials,
        sha256: Sha256,
      })

      return async (requestOptions) => {
        const { key, expiresIn, method, headers } = resolvePresignRequest(
          requestOptions,
          config.expiresIn,
        )
        const target = new URL(config.endpoint)
        target.pathname = `${target.pathname.replace(/\/+$/, '')}/${encodeURIComponent(config.bucket)}/${encodeStorageKey(key)}`
        const signingDate = new Date()
        const request = await signer.presign(
          {
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port ? Number(target.port) : undefined,
            path: target.pathname,
            method,
            headers: { ...headers },
            query: {},
          },
          { expiresIn, signingDate, signableHeaders: new Set(Object.keys(headers)) },
        )
        const query = new URLSearchParams()
        for (const [name, value] of Object.entries(request.query ?? {})) {
          for (const item of Array.isArray(value) ? value : [value]) {
            if (item !== undefined && item !== null) query.append(name, item)
          }
        }
        target.search = query.toString()
        return {
          url: target.href,
          method,
          headers,
          expiresAt: Math.floor(signingDate.getTime() / 1000) + expiresIn,
        }
      }
    },
  }
}
