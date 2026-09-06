// Phase 2 — ported from Keyforge server's src/crypto/verify.js. Same jose
// call (compactVerify, not jwtVerify — the payload uses this project's own
// field names, not registered JWT claims), same error dispatch order, same
// algorithm pin. The one substantive change: the server validates the
// parsed payload with a zod schema (entitlementToken.schema.js); this module
// has no zod dependency (deliberately dependency-light — see ARCHITECTURE.md
// §3), so assertValidPayloadShape below checks only the one field this
// module's own logic branches on (expiresAt) instead of porting the full
// schema. Signature verification already proves authenticity; the server
// validated shape at signing time.

import { compactVerify } from 'jose';

import {
  TokenVerificationError,
  TokenInvalidError,
  TokenExpiredError,
  UnknownKeyVersionError,
} from './errors.js';

/**
 * Verifies a signed entitlement token: signature, payload shape, and expiry.
 * Rejects tampered payloads, expired tokens, and unknown key versions with
 * distinct error types — everything else (malformed structure, bad
 * signature, shape violations) collapses into TokenInvalidError, since none
 * of those need different handling downstream.
 *
 * Key resolution happens via jose's own GetKeyFunction callback, keyed on
 * the header's `kid`: an error thrown inside that callback
 * (UnknownKeyVersionError below) propagates through compactVerify()
 * unmodified, with nothing verified yet at the time it runs. That's why the
 * outer catch checks `instanceof TokenVerificationError` first — without
 * that check, a naive wrap would misreport an unknown key version as a
 * generic invalid-token failure.
 */
export async function verifyEntitlementToken(
  jws,
  { publicKeysByVersion, now = Math.floor(Date.now() / 1000) },
) {
  const resolveKey = (protectedHeader) => {
    const { kid } = protectedHeader;
    if (typeof kid !== 'string' || kid.length === 0) {
      throw new TokenInvalidError('Token header is missing kid');
    }

    const key = publicKeysByVersion.get(kid);
    if (!key) {
      throw new UnknownKeyVersionError(kid);
    }

    return key;
  };

  let payloadBytes;
  let protectedHeader;
  try {
    // Pinning algorithms prevents algorithm-confusion attacks (e.g. a
    // crafted alg: 'none' or alg: 'HS256' token). For Ed25519 keys
    // specifically, jose already independently refuses both of those cases
    // via its own type checking, so this pin is currently redundant with
    // that — kept anyway as explicit, load-bearing-by-design defense in
    // depth rather than an incidental side effect of jose's internals, and
    // because it stops being redundant the moment this module ever has to
    // deal with more than one key type.
    ({ payload: payloadBytes, protectedHeader } = await compactVerify(jws, resolveKey, {
      algorithms: ['EdDSA'],
    }));
  } catch (err) {
    if (err instanceof TokenVerificationError) throw err;
    throw new TokenInvalidError('Token signature verification failed', { cause: err });
  }

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
    assertValidPayloadShape(payload);
  } catch (err) {
    throw new TokenInvalidError('Token payload invalid', { cause: err });
  }

  // Header and payload are both covered by the signature, so these can't
  // actually diverge post-verification given the server is the only writer
  // — cheap to assert anyway as a backstop against a future writer that
  // isn't.
  if (String(payload.keyVersion) !== protectedHeader.kid) {
    throw new TokenInvalidError('Token keyVersion does not match header kid');
  }

  if (now > payload.expiresAt) {
    throw new TokenExpiredError(payload.expiresAt);
  }

  return payload;
}

/**
 * Minimal shape guard, scoped to only what this module consumes.
 * `expiresAt` must be checked explicitly: `now > payload.expiresAt` is
 * `false` when `expiresAt` is `undefined` (or any other non-number), which
 * would otherwise make a malformed token silently read as "never expires"
 * instead of being rejected — the same silent-permissive-fallthrough shape
 * as the clock-rollback bug this module's clock/ guards against.
 * `keyVersion` needs no separate check — the cross-check above already
 * rejects a missing/undefined value, since `String(undefined)` can't match
 * a real `kid`. `featureIds` (keyforge-anvil's replacement for the old
 * single `productId` claim) and `features` are both passed through opaquely
 * and unvalidated: neither is compared or branched on here, only relayed to
 * the caller (`entitlement.js` surfaces both on a `valid` status).
 */
function assertValidPayloadShape(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('Entitlement token payload must be a JSON object');
  }
  if (!Number.isFinite(payload.expiresAt)) {
    throw new TypeError('Entitlement token payload is missing a valid expiresAt');
  }
}
