/**
 * Browser-side WebAuthn and Passkey client helpers.
 *
 * @module
 */

export {
  startRegistration,
  startAuthentication,
  browserSupportsPasskeys,
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  platformAuthenticatorIsAvailable,
  WebAuthnAbortService,
  WebAuthnError,
} from '@simplewebauthn/browser'
