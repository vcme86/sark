import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'

import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server'
import { isoCBOR } from '@simplewebauthn/server/helpers'

const clientData = (type: string, challenge: string, selectedOrigin: string) =>
  Buffer.from(JSON.stringify({ type, challenge, origin: selectedOrigin, crossOrigin: false }))

/** Produces valid protocol fixtures with real ECDSA signatures; it does not simulate browser behavior. */
export function createCredential(rpId = 'auth.example.com', origin = 'https://auth.example.com') {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const publicJwk = pair.publicKey.export({ format: 'jwk' })
  const idBytes = randomBytes(32)
  const id = idBytes.toString('base64url')
  const publicKey = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(publicJwk.x!, 'base64url')],
      [-3, Buffer.from(publicJwk.y!, 'base64url')],
    ]),
  )
  let userHandle: string
  return {
    id,
    registration(options: PublicKeyCredentialCreationOptionsJSON): RegistrationResponseJSON {
      userHandle = options.user.id
      const length = Buffer.alloc(2)
      length.writeUInt16BE(idBytes.length)
      const authData = Buffer.concat([
        createHash('sha256').update(rpId).digest(),
        Buffer.from([0x45]),
        Buffer.alloc(4),
        Buffer.alloc(16),
        length,
        idBytes,
        publicKey,
      ])
      const attestation = isoCBOR.encode(
        new Map<string, unknown>([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', authData],
        ]) as Parameters<typeof isoCBOR.encode>[0],
      )
      return {
        id,
        rawId: id,
        type: 'public-key',
        clientExtensionResults: { credProps: { rk: true } },
        response: {
          clientDataJSON: clientData('webauthn.create', options.challenge, origin).toString(
            'base64url',
          ),
          attestationObject: Buffer.from(attestation).toString('base64url'),
          transports: ['internal'],
        },
      }
    },
    authentication(
      options: PublicKeyCredentialRequestOptionsJSON,
      overrides: {
        challenge?: string
        origin?: string
        rpId?: string
        userVerified?: boolean
        counter?: number
        corruptSignature?: boolean
      } = {},
    ): AuthenticationResponseJSON {
      const data = clientData(
        'webauthn.get',
        overrides.challenge ?? options.challenge,
        overrides.origin ?? origin,
      )
      const counter = Buffer.alloc(4)
      counter.writeUInt32BE(overrides.counter ?? 1)
      const authData = Buffer.concat([
        createHash('sha256')
          .update(overrides.rpId ?? rpId)
          .digest(),
        Buffer.from([overrides.userVerified === false ? 1 : 5]),
        counter,
      ])
      const signature = sign(
        'sha256',
        Buffer.concat([authData, createHash('sha256').update(data).digest()]),
        pair.privateKey,
      )
      if (overrides.corruptSignature) signature[signature.length - 1] ^= 1
      return {
        id,
        rawId: id,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: data.toString('base64url'),
          authenticatorData: authData.toString('base64url'),
          signature: signature.toString('base64url'),
          userHandle,
        },
      }
    },
  }
}
