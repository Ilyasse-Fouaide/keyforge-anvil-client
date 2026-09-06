import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createEntitlementChecker } from '../../src/entitlement.js';
import { createJsonFileAdapter } from '../../src/storage/json-file.js';
import {
  buildEntitlementPayload,
  generateTestKeyPair,
  signTestToken,
  tamperPayload,
} from '../helpers/crypto.js';
import { createMemoryAdapter } from '../helpers/memoryAdapter.js';

describe('getEntitlement (offline-flow composition)', () => {
  let keyPair;

  beforeAll(async () => {
    keyPair = await generateTestKeyPair();
  });

  let storage;

  beforeEach(() => {
    storage = createMemoryAdapter();
  });

  async function createChecker({ getNow, publicKeys } = {}) {
    return createEntitlementChecker({
      storage,
      publicKeys: publicKeys ?? { 1: keyPair.publicKeyPem },
      getNow,
    });
  }

  it('reports not_activated when no token is stored at all', async () => {
    const { getEntitlement } = await createChecker();

    await expect(getEntitlement()).resolves.toEqual({ status: 'not_activated' });
  });

  it('reports valid for a correctly signed, current token', async () => {
    const claims = buildEntitlementPayload();
    const jws = await signTestToken(claims, { privateKey: keyPair.privateKey, kid: '1' });
    await storage.set('entitlementToken', jws);
    await storage.set('lastValidatedAt', String(claims.issuedAt - 10));

    const { getEntitlement } = await createChecker({ getNow: () => claims.issuedAt });

    await expect(getEntitlement()).resolves.toEqual({
      status: 'valid',
      expiresAt: claims.expiresAt,
      featureIds: claims.featureIds,
      features: claims.features,
    });
  });

  describe('featureIds surfacing (keyforge-anvil token contract)', () => {
    it('relays the verified token featureIds array verbatim onto the valid status', async () => {
      const claims = buildEntitlementPayload({ featureIds: ['feat_a', 'feat_b', 'feat_c'] });
      const jws = await signTestToken(claims, { privateKey: keyPair.privateKey, kid: '1' });
      await storage.set('entitlementToken', jws);
      await storage.set('lastValidatedAt', String(claims.issuedAt - 10));

      const { getEntitlement } = await createChecker({ getNow: () => claims.issuedAt });

      const result = await getEntitlement();
      expect(result.status).toBe('valid');
      expect(result.featureIds).toEqual(['feat_a', 'feat_b', 'feat_c']);
    });

    it('surfaces a different featureIds set for a different token (not hardcoded)', async () => {
      const claims = buildEntitlementPayload({ featureIds: ['only_one_feature'] });
      const jws = await signTestToken(claims, { privateKey: keyPair.privateKey, kid: '1' });
      await storage.set('entitlementToken', jws);
      await storage.set('lastValidatedAt', String(claims.issuedAt - 10));

      const { getEntitlement } = await createChecker({ getNow: () => claims.issuedAt });

      await expect(getEntitlement()).resolves.toMatchObject({
        status: 'valid',
        featureIds: ['only_one_feature'],
      });
    });
  });

  it('reports tampered for a token whose payload was mutated post-signing', async () => {
    const claims = buildEntitlementPayload();
    const signed = await signTestToken(claims, { privateKey: keyPair.privateKey, kid: '1' });
    const tampered = tamperPayload(signed, (payload) => ({
      ...payload,
      features: { maxBranches: 999 },
    }));
    await storage.set('entitlementToken', tampered);
    await storage.set('lastValidatedAt', String(claims.issuedAt - 10));

    const { getEntitlement } = await createChecker({ getNow: () => claims.issuedAt });

    await expect(getEntitlement()).resolves.toEqual({ status: 'tampered' });
  });

  it('reports expired once now passes expiresAt', async () => {
    const claims = buildEntitlementPayload({ issuedAt: 1_700_000_000, expiresAt: 1_700_003_600 });
    const jws = await signTestToken(claims, { privateKey: keyPair.privateKey, kid: '1' });
    await storage.set('entitlementToken', jws);
    // Chosen before expiresAt, so the clock check passes and isolates the expiry check.
    await storage.set('lastValidatedAt', String(claims.expiresAt - 10));

    const { getEntitlement } = await createChecker({ getNow: () => claims.expiresAt + 1 });

    await expect(getEntitlement()).resolves.toEqual({ status: 'expired' });
  });

  it('reports unknown_key_version when the token kid is not in the configured publicKeys', async () => {
    const otherKeyPair = await generateTestKeyPair();
    const claims = buildEntitlementPayload({ keyVersion: 2 });
    const jws = await signTestToken(claims, { privateKey: otherKeyPair.privateKey, kid: '2' });
    await storage.set('entitlementToken', jws);
    await storage.set('lastValidatedAt', String(claims.issuedAt - 10));

    // Checker is only configured with kid '1' (via the default in createChecker).
    const { getEntitlement } = await createChecker({ getNow: () => claims.issuedAt });

    await expect(getEntitlement()).resolves.toEqual({ status: 'unknown_key_version' });
  });

  it('reports clock_rollback when now is behind the stored lastValidatedAt', async () => {
    const claims = buildEntitlementPayload();
    const jws = await signTestToken(claims, { privateKey: keyPair.privateKey, kid: '1' });
    await storage.set('entitlementToken', jws);
    await storage.set('lastValidatedAt', String(claims.issuedAt + 1000));

    const { getEntitlement } = await createChecker({ getNow: () => claims.issuedAt });

    await expect(getEntitlement()).resolves.toEqual({ status: 'clock_rollback' });
  });

  it('does not report clock_rollback when now exactly equals lastValidatedAt', async () => {
    const claims = buildEntitlementPayload();
    const jws = await signTestToken(claims, { privateKey: keyPair.privateKey, kid: '1' });
    await storage.set('entitlementToken', jws);
    await storage.set('lastValidatedAt', String(claims.issuedAt));

    const { getEntitlement } = await createChecker({ getNow: () => claims.issuedAt });

    await expect(getEntitlement()).resolves.toEqual({
      status: 'valid',
      expiresAt: claims.expiresAt,
      featureIds: claims.featureIds,
      features: claims.features,
    });
  });

  it('fails closed with clock_rollback when entitlementToken exists but lastValidatedAt was never written', async () => {
    const claims = buildEntitlementPayload();
    const jws = await signTestToken(claims, { privateKey: keyPair.privateKey, kid: '1' });
    await storage.set('entitlementToken', jws);
    // lastValidatedAt deliberately never set — simulates the state before
    // Phase 3's activate() has ever run.

    const { getEntitlement } = await createChecker({ getNow: () => claims.issuedAt });

    await expect(getEntitlement()).resolves.toEqual({ status: 'clock_rollback' });
    await expect(storage.get('lastValidatedAt')).resolves.toBeNull();
  });

  it('short-circuits before signature verification: a garbage token with a rollback condition reports clock_rollback, not tampered', async () => {
    await storage.set('entitlementToken', 'not-a-real-jws-at-all');
    await storage.set('lastValidatedAt', '2000');

    const { getEntitlement } = await createChecker({ getNow: () => 1000 }); // behind the watermark

    await expect(getEntitlement()).resolves.toEqual({ status: 'clock_rollback' });
  });

  it('reports tampered for a malformed, non-JWS token when the clock check is not in play', async () => {
    await storage.set('entitlementToken', 'not-a-real-jws-at-all');
    await storage.set('lastValidatedAt', '900');

    const { getEntitlement } = await createChecker({ getNow: () => 1000 }); // now > lastValidatedAt, no rollback

    await expect(getEntitlement()).resolves.toEqual({ status: 'tampered' });
  });

  it('reports tampered for an empty-string token', async () => {
    await storage.set('entitlementToken', '');
    await storage.set('lastValidatedAt', '900');

    const { getEntitlement } = await createChecker({ getNow: () => 1000 });

    await expect(getEntitlement()).resolves.toEqual({ status: 'tampered' });
  });

  describe('stale token replay protection (highestIssuedAtSeen)', () => {
    it('rejects a superseded token restored after a newer one was already seen, even though it is still validly signed and unexpired', async () => {
      const oldClaims = buildEntitlementPayload({
        issuedAt: 1_700_000_000,
        expiresAt: 1_700_010_000,
      });
      const oldJws = await signTestToken(oldClaims, { privateKey: keyPair.privateKey, kid: '1' });

      const newClaims = buildEntitlementPayload({
        issuedAt: 1_700_005_000,
        expiresAt: 1_700_015_000,
      });
      const newJws = await signTestToken(newClaims, { privateKey: keyPair.privateKey, kid: '1' });

      let currentNow = oldClaims.issuedAt;
      const { getEntitlement } = await createChecker({ getNow: () => currentNow });

      await storage.set('entitlementToken', oldJws);
      await storage.set('lastValidatedAt', String(oldClaims.issuedAt - 10));
      await expect(getEntitlement()).resolves.toEqual({
        status: 'valid',
        expiresAt: oldClaims.expiresAt,
        featureIds: oldClaims.featureIds,
        features: oldClaims.features,
      });

      // A newer token supersedes it (e.g. a normal refresh with a downgrade).
      currentNow = newClaims.issuedAt;
      await storage.set('entitlementToken', newJws);
      await expect(getEntitlement()).resolves.toEqual({
        status: 'valid',
        expiresAt: newClaims.expiresAt,
        featureIds: newClaims.featureIds,
        features: newClaims.features,
      });

      // Attacker restores the old (still validly-signed, still-unexpired) file.
      currentNow = newClaims.issuedAt + 1;
      await storage.set('entitlementToken', oldJws);
      await expect(getEntitlement()).resolves.toEqual({ status: 'tampered' });
    });

    it('does not reject re-verifying the same token repeatedly', async () => {
      const claims = buildEntitlementPayload();
      const jws = await signTestToken(claims, { privateKey: keyPair.privateKey, kid: '1' });
      await storage.set('entitlementToken', jws);
      await storage.set('lastValidatedAt', String(claims.issuedAt - 10));

      let currentNow = claims.issuedAt;
      const { getEntitlement } = await createChecker({ getNow: () => currentNow });

      await expect(getEntitlement()).resolves.toMatchObject({ status: 'valid' });
      currentNow += 1;
      await expect(getEntitlement()).resolves.toMatchObject({ status: 'valid' });
      currentNow += 1;
      await expect(getEntitlement()).resolves.toMatchObject({ status: 'valid' });
    });

    it('accepts the first token an installation ever verifies with no prior highestIssuedAtSeen', async () => {
      const claims = buildEntitlementPayload();
      const jws = await signTestToken(claims, { privateKey: keyPair.privateKey, kid: '1' });
      await storage.set('entitlementToken', jws);
      await storage.set('lastValidatedAt', String(claims.issuedAt - 10));

      const { getEntitlement } = await createChecker({ getNow: () => claims.issuedAt });

      await expect(getEntitlement()).resolves.toEqual({
        status: 'valid',
        expiresAt: claims.expiresAt,
        featureIds: claims.featureIds,
        features: claims.features,
      });
      await expect(storage.get('highestIssuedAtSeen')).resolves.toBe(String(claims.issuedAt));
    });
  });

  describe('lastValidatedAt watermark', () => {
    it('advances to now after a check that resolves valid', async () => {
      const claims = buildEntitlementPayload();
      const jws = await signTestToken(claims, { privateKey: keyPair.privateKey, kid: '1' });
      await storage.set('entitlementToken', jws);
      await storage.set('lastValidatedAt', String(claims.issuedAt - 10));

      const { getEntitlement } = await createChecker({ getNow: () => claims.issuedAt });
      await getEntitlement();

      await expect(storage.get('lastValidatedAt')).resolves.toBe(String(claims.issuedAt));
    });

    it('advances to now after a check that resolves expired', async () => {
      const claims = buildEntitlementPayload({ issuedAt: 1_700_000_000, expiresAt: 1_700_003_600 });
      const jws = await signTestToken(claims, { privateKey: keyPair.privateKey, kid: '1' });
      await storage.set('entitlementToken', jws);
      const now = claims.expiresAt + 1;
      await storage.set('lastValidatedAt', String(now - 10));

      const { getEntitlement } = await createChecker({ getNow: () => now });
      await getEntitlement();

      await expect(storage.get('lastValidatedAt')).resolves.toBe(String(now));
    });

    it('advances to now after a check that resolves tampered', async () => {
      const claims = buildEntitlementPayload();
      const signed = await signTestToken(claims, { privateKey: keyPair.privateKey, kid: '1' });
      const jws = tamperPayload(signed, (payload) => ({
        ...payload,
        features: { maxBranches: 999 },
      }));
      await storage.set('entitlementToken', jws);
      await storage.set('lastValidatedAt', String(claims.issuedAt - 10));

      const { getEntitlement } = await createChecker({ getNow: () => claims.issuedAt });
      await getEntitlement();

      await expect(storage.get('lastValidatedAt')).resolves.toBe(String(claims.issuedAt));
    });

    it('advances to now after a check that resolves unknown_key_version', async () => {
      const otherKeyPair = await generateTestKeyPair();
      const claims = buildEntitlementPayload({ keyVersion: 2 });
      const jws = await signTestToken(claims, { privateKey: otherKeyPair.privateKey, kid: '2' });
      await storage.set('entitlementToken', jws);
      await storage.set('lastValidatedAt', String(claims.issuedAt - 10));

      const { getEntitlement } = await createChecker({ getNow: () => claims.issuedAt });
      await getEntitlement();

      await expect(storage.get('lastValidatedAt')).resolves.toBe(String(claims.issuedAt));
    });

    it('does not advance when a rollback is detected', async () => {
      const claims = buildEntitlementPayload();
      const jws = await signTestToken(claims, { privateKey: keyPair.privateKey, kid: '1' });
      await storage.set('entitlementToken', jws);
      await storage.set('lastValidatedAt', '5000');

      const { getEntitlement } = await createChecker({ getNow: () => 1000 });
      await getEntitlement();

      await expect(storage.get('lastValidatedAt')).resolves.toBe('5000');
    });
  });

  describe('revoked flag (Phase 3)', () => {
    it('reports revoked and short-circuits before touching the clock or the token, when the flag is set', async () => {
      const claims = buildEntitlementPayload();
      const jws = await signTestToken(claims, { privateKey: keyPair.privateKey, kid: '1' });
      await storage.set('entitlementToken', jws);
      // Deliberately no lastValidatedAt at all — a normal check would fail
      // closed with clock_rollback; revoked must win regardless.
      await storage.set('revoked', 'true');

      const { getEntitlement } = await createChecker({ getNow: () => claims.issuedAt });

      await expect(getEntitlement()).resolves.toEqual({ status: 'revoked' });
      await expect(storage.get('lastValidatedAt')).resolves.toBeNull();
    });

    it('does not report revoked when the flag is absent', async () => {
      const claims = buildEntitlementPayload();
      const jws = await signTestToken(claims, { privateKey: keyPair.privateKey, kid: '1' });
      await storage.set('entitlementToken', jws);
      await storage.set('lastValidatedAt', String(claims.issuedAt - 10));

      const { getEntitlement } = await createChecker({ getNow: () => claims.issuedAt });

      await expect(getEntitlement()).resolves.toMatchObject({ status: 'valid' });
    });
  });

  describe('installationId check (Phase 3)', () => {
    it('reports tampered for a validly-signed, unexpired token issued to a different installation', async () => {
      const claims = buildEntitlementPayload({ installationId: 'inst_this_device' });
      const jws = await signTestToken(claims, { privateKey: keyPair.privateKey, kid: '1' });
      await storage.set('entitlementToken', jws);
      await storage.set('lastValidatedAt', String(claims.issuedAt - 10));
      // Simulates activate() having recorded a DIFFERENT installationId
      // than the one embedded in this (otherwise perfectly valid) token —
      // e.g. this token file was copied from another device.
      await storage.set('installationId', 'inst_other_device');

      const { getEntitlement } = await createChecker({ getNow: () => claims.issuedAt });

      await expect(getEntitlement()).resolves.toEqual({ status: 'tampered' });
    });

    it('reports valid when the token installationId matches the stored one', async () => {
      const claims = buildEntitlementPayload({ installationId: 'inst_this_device' });
      const jws = await signTestToken(claims, { privateKey: keyPair.privateKey, kid: '1' });
      await storage.set('entitlementToken', jws);
      await storage.set('lastValidatedAt', String(claims.issuedAt - 10));
      await storage.set('installationId', 'inst_this_device');

      const { getEntitlement } = await createChecker({ getNow: () => claims.issuedAt });

      await expect(getEntitlement()).resolves.toEqual({
        status: 'valid',
        expiresAt: claims.expiresAt,
        featureIds: claims.featureIds,
        features: claims.features,
      });
    });

    it('reports valid when no installationId has ever been stored (pre-Phase-3 state)', async () => {
      const claims = buildEntitlementPayload();
      const jws = await signTestToken(claims, { privateKey: keyPair.privateKey, kid: '1' });
      await storage.set('entitlementToken', jws);
      await storage.set('lastValidatedAt', String(claims.issuedAt - 10));

      const { getEntitlement } = await createChecker({ getNow: () => claims.issuedAt });

      await expect(getEntitlement()).resolves.toMatchObject({ status: 'valid' });
    });
  });

  describe('unexpected storage errors', () => {
    let tempDir;

    beforeEach(async () => {
      tempDir = await mkdtemp(path.join(os.tmpdir(), 'keyforge-client-entitlement-'));
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it('propagates a corrupted state file rather than resolving any status', async () => {
      const filePath = path.join(tempDir, 'state.json');
      await writeFile(filePath, '{ this is not valid json', 'utf8');
      const fileStorage = createJsonFileAdapter({ filePath });

      const { getEntitlement } = await createEntitlementChecker({
        storage: fileStorage,
        publicKeys: { 1: keyPair.publicKeyPem },
      });

      await expect(getEntitlement()).rejects.toThrow(SyntaxError);
    });
  });
});
