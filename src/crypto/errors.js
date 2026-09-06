// Phase 2 — ported from the keyforge server's src/crypto/errors.js, unchanged
// (keyforge-anvil's equivalent is identical).
//
// Deliberately does NOT extend a shared app-wide error base: this stays
// framework-agnostic, and translating these into keyforge-anvil-client's own
// status-object vocabulary is entitlement.js's job, not this file's.
//
// "Malformed" and "tampered" both collapse into TokenInvalidError rather
// than getting their own classes — both mean "reject, don't trust this
// token," and no caller needs to treat them differently. TokenExpiredError
// and UnknownKeyVersionError stay distinct because a caller plausibly does
// want to handle those differently (prompt a refresh vs. flag a stale
// embedded key).

export class TokenVerificationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

export class TokenInvalidError extends TokenVerificationError {
  code = 'TOKEN_INVALID';
}

export class TokenExpiredError extends TokenVerificationError {
  code = 'TOKEN_EXPIRED';

  constructor(expiresAt, options) {
    super(`Token expired at ${expiresAt}`, options);
    this.expiresAt = expiresAt;
  }
}

export class UnknownKeyVersionError extends TokenVerificationError {
  code = 'UNKNOWN_KEY_VERSION';

  constructor(keyVersion, options) {
    super(`Unknown signing key version: ${keyVersion}`, options);
    this.keyVersion = keyVersion;
  }
}
