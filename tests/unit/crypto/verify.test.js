import { describe, expect, it } from 'vitest';

import {
  TokenExpiredError,
  TokenInvalidError,
  UnknownKeyVersionError,
} from '../../../src/crypto/errors.js';
import { verifyEntitlementToken } from '../../../src/crypto/verify.js';
import {
  buildEntitlementPayload,
  generateTestKeyPair,
  signTestToken,
  tamperPayload,
} from '../../helpers/crypto.js';

describe('verifyEntitlementToken', () => {
  it('accepts a valid token, resolving the verified payload with keyVersion as a number', async () => {
    const { privateKey, publicKey } = await generateTestKeyPair();
    const claims = buildEntitlementPayload();
    const jws = await signTestToken(claims, { privateKey, kid: '1' });
    const publicKeysByVersion = new Map([['1', publicKey]]);

    const payload = await verifyEntitlementToken(jws, {
      publicKeysByVersion,
      now: claims.issuedAt,
    });

    expect(payload).toMatchObject(claims);
    expect(typeof payload.keyVersion).toBe('number');
    // keyforge-anvil replaced the single productId claim with a featureIds
    // array — verify relays it verbatim (no schema check on this end).
    expect(payload.featureIds).toEqual(claims.featureIds);
    expect(payload).not.toHaveProperty('productId');
  });

  it('rejects a tampered payload with TokenInvalidError', async () => {
    const { privateKey, publicKey } = await generateTestKeyPair();
    const claims = buildEntitlementPayload();
    const signed = await signTestToken(claims, { privateKey, kid: '1' });
    const tampered = tamperPayload(signed, (payload) => ({
      ...payload,
      features: { maxBranches: 999 },
    }));
    const publicKeysByVersion = new Map([['1', publicKey]]);

    await expect(
      verifyEntitlementToken(tampered, { publicKeysByVersion, now: claims.issuedAt }),
    ).rejects.toThrow(TokenInvalidError);
  });

  it('rejects an expired token with TokenExpiredError, carrying the exceeded expiresAt', async () => {
    const { privateKey, publicKey } = await generateTestKeyPair();
    const claims = buildEntitlementPayload({ expiresAt: 1_700_000_100 });
    const jws = await signTestToken(claims, { privateKey, kid: '1' });
    const publicKeysByVersion = new Map([['1', publicKey]]);

    await expect(
      verifyEntitlementToken(jws, { publicKeysByVersion, now: claims.expiresAt + 1 }),
    ).rejects.toThrow(TokenExpiredError);

    try {
      await verifyEntitlementToken(jws, { publicKeysByVersion, now: claims.expiresAt + 1 });
    } catch (err) {
      expect(err.expiresAt).toBe(claims.expiresAt);
    }
  });

  it('rejects an unknown keyVersion with UnknownKeyVersionError, carrying the offending kid as a string', async () => {
    const { privateKey } = await generateTestKeyPair();
    const { publicKey: otherPublicKey } = await generateTestKeyPair();
    const claims = buildEntitlementPayload({ keyVersion: 2 });
    const jws = await signTestToken(claims, { privateKey, kid: '2' });
    const publicKeysByVersion = new Map([['1', otherPublicKey]]);

    await expect(
      verifyEntitlementToken(jws, { publicKeysByVersion, now: claims.issuedAt }),
    ).rejects.toThrow(UnknownKeyVersionError);

    try {
      await verifyEntitlementToken(jws, { publicKeysByVersion, now: claims.issuedAt });
    } catch (err) {
      expect(err.keyVersion).toBe('2');
    }
  });

  it('rejects a string that is not a JWS at all, cleanly, with TokenInvalidError', async () => {
    const { publicKey } = await generateTestKeyPair();
    const publicKeysByVersion = new Map([['1', publicKey]]);

    await expect(
      verifyEntitlementToken('definitely-not-a-jws', { publicKeysByVersion, now: 1000 }),
    ).rejects.toThrow(TokenInvalidError);
  });

  it('rejects an empty string, cleanly, with TokenInvalidError', async () => {
    const { publicKey } = await generateTestKeyPair();
    const publicKeysByVersion = new Map([['1', publicKey]]);

    await expect(verifyEntitlementToken('', { publicKeysByVersion, now: 1000 })).rejects.toThrow(
      TokenInvalidError,
    );
  });

  it('rejects a token whose header is missing kid with TokenInvalidError', async () => {
    const { privateKey, publicKey } = await generateTestKeyPair();
    const claims = buildEntitlementPayload();
    const jws = await signTestToken(claims, { privateKey, kid: undefined });
    const publicKeysByVersion = new Map([['1', publicKey]]);

    await expect(
      verifyEntitlementToken(jws, { publicKeysByVersion, now: claims.issuedAt }),
    ).rejects.toThrow(TokenInvalidError);
  });

  it.each([
    ['missing (dropped by JSON serialization)', undefined],
    ['a non-numeric string', 'not-a-number'],
  ])(
    'rejects a validly-signed token whose expiresAt is %s with TokenInvalidError',
    async (_name, expiresAt) => {
      const { privateKey, publicKey } = await generateTestKeyPair();
      const claims = buildEntitlementPayload({ expiresAt });
      const jws = await signTestToken(claims, { privateKey, kid: '1' });
      const publicKeysByVersion = new Map([['1', publicKey]]);

      await expect(
        verifyEntitlementToken(jws, { publicKeysByVersion, now: claims.issuedAt }),
      ).rejects.toThrow(TokenInvalidError);
    },
  );

  it('rejects a token signed with a different keypair than the one on file for its kid', async () => {
    const { privateKey: wrongPrivateKey } = await generateTestKeyPair();
    const { publicKey: expectedPublicKey } = await generateTestKeyPair();
    const claims = buildEntitlementPayload();
    const jws = await signTestToken(claims, { privateKey: wrongPrivateKey, kid: '1' });
    const publicKeysByVersion = new Map([['1', expectedPublicKey]]);

    await expect(
      verifyEntitlementToken(jws, { publicKeysByVersion, now: claims.issuedAt }),
    ).rejects.toThrow(TokenInvalidError);
  });
});
