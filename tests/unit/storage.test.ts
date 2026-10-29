import { describe, expect, it } from 'vitest'

import { validateUploadFilename } from '../../src/services/storage/local'
import {
  validateR2PresignConfig,
  validateS3PresignConfig,
} from '../../src/services/storage/presign-config'
import { buildPublicUrl, StorageError, validateStorageKey } from '../../src/services/storage/types'

describe('Storage Unit Tests', () => {
  describe('validateStorageKey', () => {
    it('accepts normalized paths and multi-segment keys', () => {
      expect(validateStorageKey('avatar.png')).toBe('avatar.png')
      expect(validateStorageKey('users/123/profile.jpg')).toBe('users/123/profile.jpg')
      expect(validateStorageKey('deep/nested/folder/file.txt')).toBe('deep/nested/folder/file.txt')
    })

    it('rejects empty or non-string inputs', () => {
      expect(() => validateStorageKey('')).toThrow(StorageError)
      expect(() => validateStorageKey(null as any)).toThrow(StorageError)
      expect(() => validateStorageKey(undefined as any)).toThrow(StorageError)
    })

    it('rejects path traversal and relative dot segments', () => {
      expect(() => validateStorageKey('../secret.txt')).toThrow('relative dot segments')
      expect(() => validateStorageKey('users/../../secret.txt')).toThrow('relative dot segments')
      expect(() => validateStorageKey('users/./avatar.png')).toThrow('relative dot segments')
      expect(() => validateStorageKey('users/../avatar.png')).toThrow('relative dot segments')
    })

    it('rejects leading slashes and null bytes', () => {
      expect(() => validateStorageKey('/root/file.txt')).toThrow(
        'must not start with a path separator',
      )
      expect(() => validateStorageKey('\\win\\file.txt')).toThrow(
        'must not start with a path separator',
      )
      expect(() => validateStorageKey('file\0.txt')).toThrow('must not contain null bytes')
    })

    it('rejects trailing slashes and empty path segments (consecutive slashes)', () => {
      expect(() => validateStorageKey('folder/')).toThrow('must not end with a path separator')
      expect(() => validateStorageKey('folder\\')).toThrow('must not end with a path separator')
      expect(() => validateStorageKey('users//profile.jpg')).toThrow('empty path segments')
    })
  })

  describe('buildPublicUrl', () => {
    it('returns undefined if publicUrl is not provided', () => {
      expect(buildPublicUrl(undefined, 'images/test.png')).toBeUndefined()
      expect(buildPublicUrl('', 'images/test.png')).toBeUndefined()
    })

    it('encodes each segment individually, preserving slashes', () => {
      expect(buildPublicUrl('https://cdn.example.com', 'images/test.png')).toBe(
        'https://cdn.example.com/images/test.png',
      )
      expect(buildPublicUrl('https://cdn.example.com/', 'users/alice/my photo.jpg')).toBe(
        'https://cdn.example.com/users/alice/my%20photo.jpg',
      )
      expect(buildPublicUrl('/uploads', 'files/c# & python?.pdf')).toBe(
        '/uploads/files/c%23%20%26%20python%3F.pdf',
      )
    })
  })

  describe('validateUploadFilename', () => {
    it('accepts safe single-segment filenames', () => {
      expect(validateUploadFilename('document.pdf')).toBe('document.pdf')
      expect(validateUploadFilename('my-archive_2026.tar.gz')).toBe('my-archive_2026.tar.gz')
    })

    it('rejects path separators, dot segments and null bytes', () => {
      expect(() => validateUploadFilename('path/to/file.txt')).toThrow('directory separators')
      expect(() => validateUploadFilename('path\\to\\file.txt')).toThrow('directory separators')
      expect(() => validateUploadFilename('.')).toThrow('relative dot segment')
      expect(() => validateUploadFilename('..')).toThrow('relative dot segment')
      expect(() => validateUploadFilename('file\0.png')).toThrow('null bytes')
      expect(() => validateUploadFilename('')).toThrow('non-empty string')
    })
  })

  describe('Presign Config Validation', () => {
    it('validates S3 presign options and rejects repeated target fields', () => {
      expect(validateS3PresignConfig()).toEqual({ expiresIn: 300 })
      expect(validateS3PresignConfig({ expiresIn: 60 })).toEqual({ expiresIn: 60 })

      expect(() =>
        validateS3PresignConfig({
          expiresIn: 300,
          endpoint: 'https://custom.endpoint',
        } as any),
      ).toThrow('S3 presign configuration must not specify endpoint')

      expect(() =>
        validateS3PresignConfig({
          expiresIn: 300,
          bucket: 'override-bucket',
        } as any),
      ).toThrow('S3 presign configuration must not specify bucket')

      expect(() =>
        validateS3PresignConfig({
          expiresIn: 300,
          region: 'us-west-2',
        } as any),
      ).toThrow('S3 presign configuration must not specify region')

      expect(() =>
        validateS3PresignConfig({
          expiresIn: 300,
          credentials: { accessKeyId: 'a', secretAccessKey: 'b' },
        } as any),
      ).toThrow('S3 presign configuration must not specify credentials')

      expect(() => validateS3PresignConfig({ expiresIn: -5 })).toThrow('integer from 1 to 604800')
    })

    it('validates R2 presign options requiring endpoint, bucket, and credentials', () => {
      expect(() => validateR2PresignConfig(undefined as any)).toThrow(
        'R2 presign requires a presign configuration',
      )

      expect(() =>
        validateR2PresignConfig({
          endpoint: '',
          bucket: 'b',
          credentials: { accessKeyId: 'k', secretAccessKey: 's' },
        }),
      ).toThrow('valid S3-compatible endpoint URL')

      expect(() =>
        validateR2PresignConfig({
          endpoint: 'https://account.r2.cloudflarestorage.com',
          bucket: '',
          credentials: { accessKeyId: 'k', secretAccessKey: 's' },
        }),
      ).toThrow('valid bucket name')

      expect(() =>
        validateR2PresignConfig({
          endpoint: 'https://account.r2.cloudflarestorage.com',
          bucket: 'my-bucket',
          credentials: { accessKeyId: '', secretAccessKey: '' },
        }),
      ).toThrow('accessKeyId and secretAccessKey')

      const valid = validateR2PresignConfig({
        endpoint: 'https://account.r2.cloudflarestorage.com',
        bucket: 'my-bucket',
        credentials: { accessKeyId: 'key123', secretAccessKey: 'secret123' },
      })
      expect(valid.region).toBe('auto')
      expect(valid.expiresIn).toBe(300)
    })
  })
})
