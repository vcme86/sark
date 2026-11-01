/**
 * Browser-side WebAuthn and Passkey client helpers.
 *
 * @module
 */

export {
  browserSupportsPasskeys,
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  platformAuthenticatorIsAvailable,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
  WebAuthnError,
} from '@simplewebauthn/browser'
