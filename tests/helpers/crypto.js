// Test-only fixtures for signing compact JWS entitlement tokens. Signing is
// exclusively a server-side (Keyforge) concern in production — this repo
// never ships a sign.js of its own — but this module's own test suite needs
// to construct validly-signed (and deliberately broken) tokens to exercise
// verifyEntitlementToken/getEntitlement against.

import { CompactSign, exportSPKI, generateKeyPair } from 'jose';

/**
 * @returns {Promise<{ privateKey: CryptoKey, publicKey: CryptoKey, publicKeyPem: string }>}
 */
export async function generateTestKeyPair() {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA');
  const publicKeyPem = await exportSPKI(publicKey);
  return { privateKey, publicKey, publicKeyPem };
}

/**
 * A plausible full entitlement token payload with sensible defaults.
 * Override only the fields a given test cares about.
 * @param {object} [overrides]
 */
export function buildEntitlementPayload(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    licenseId: 'lic_test',
    installationId: 'inst_test',
    featureIds: ['feature_menu', 'feature_orders'],
    status: 'active',
    features: { maxBranches: 3 },
    issuedAt: now,
    expiresAt: now + 3600,
    keyVersion: 1,
    ...overrides,
  };
}

/**
 * Signs `payload` as a compact JWS. `kid` is intentionally independent of
 * `payload.keyVersion` — tests can deliberately mismatch them. Passing
 * `kid: undefined` omits the header property entirely (rather than setting
 * it to `undefined`), so the resolveKey callback's `typeof kid !== 'string'`
 * branch is exercised faithfully.
 * @param {object} payload
 * @param {{ privateKey: CryptoKey, kid?: string }} options
 * @returns {Promise<string>} compact JWS
 */
export async function signTestToken(payload, { privateKey, kid }) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return new CompactSign(bytes)
    .setProtectedHeader({ alg: 'EdDSA', ...(kid !== undefined ? { kid } : {}) })
    .sign(privateKey);
}

/**
 * Returns a copy of `jws` with its payload segment base64url-decoded,
 * passed through `mutate`, and re-encoded. The header and signature
 * segments are left untouched, so the result is structurally a valid
 * compact JWS whose signature no longer matches its payload.
 * @param {string} jws
 * @param {(payload: object) => object} mutate
 * @returns {string}
 */
export function tamperPayload(jws, mutate) {
  const [headerSeg, payloadSeg, sigSeg] = jws.split('.');
  const payload = JSON.parse(Buffer.from(payloadSeg, 'base64url').toString('utf8'));
  const mutated = mutate(payload);
  const mutatedSeg = Buffer.from(JSON.stringify(mutated)).toString('base64url');
  return `${headerSeg}.${mutatedSeg}.${sigSeg}`;
}
