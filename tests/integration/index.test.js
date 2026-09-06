// Phase 4 — end-to-end test for the composed public API (createKeyforgeClient).
//
// Unlike activate.test.js/refresh.test.js/deactivate.test.js, which each
// construct one factory directly, this exercises the thing only index.js
// introduces: that all four bound functions returned by a single
// createKeyforgeClient() call genuinely share the same storage instance
// through a real activate -> getEntitlement -> refresh -> getEntitlement ->
// deactivate -> getEntitlement chain.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { createKeyforgeClient } from '../../src/index.js';
import { buildEntitlementPayload, generateTestKeyPair, signTestToken } from '../helpers/crypto.js';
import { emptyResponse, jsonResponse, queueFetch } from '../helpers/fakeFetch.js';
import { createMemoryAdapter } from '../helpers/memoryAdapter.js';

const BASE_URL = 'https://keyforge.example.test';

describe('createKeyforgeClient() (end-to-end)', () => {
  let keyPair;

  beforeAll(async () => {
    keyPair = await generateTestKeyPair();
  });

  async function activationResponse({ installationId = 'inst_abc', claimOverrides = {} } = {}) {
    const claims = buildEntitlementPayload({ installationId, ...claimOverrides });
    const entitlementToken = await signTestToken(claims, {
      privateKey: keyPair.privateKey,
      kid: '1',
    });
    return {
      response: jsonResponse(201, {
        data: {
          entitlementToken,
          installationToken: 'install-token-xyz',
          installationId,
          expiresAt: claims.expiresAt,
        },
      }),
      claims,
    };
  }

  async function refreshResponse({ installationId = 'inst_abc', claimOverrides = {} } = {}) {
    const claims = buildEntitlementPayload({ installationId, ...claimOverrides });
    const entitlementToken = await signTestToken(claims, {
      privateKey: keyPair.privateKey,
      kid: '1',
    });
    return {
      response: jsonResponse(200, { data: { entitlementToken, expiresAt: claims.expiresAt } }),
      claims,
    };
  }

  it('runs the full activate -> getEntitlement -> refresh -> getEntitlement -> deactivate -> getEntitlement chain through one shared client', async () => {
    const storage = createMemoryAdapter();
    const t0 = 1_700_000_000;
    let now = t0;

    const { response: activateResp, claims: claims1 } = await activationResponse({
      claimOverrides: { issuedAt: t0 - 100, expiresAt: t0 + 3600 },
    });
    const { response: refreshResp, claims: claims2 } = await refreshResponse({
      claimOverrides: { issuedAt: t0 + 50, expiresAt: t0 + 4000 },
    });
    const fetchImpl = queueFetch([activateResp, refreshResp, emptyResponse(204)]);

    const client = await createKeyforgeClient({
      storage,
      publicKeys: { 1: keyPair.publicKeyPem },
      baseUrl: BASE_URL,
      fetchImpl,
      getNow: () => now,
    });

    const activateResult = await client.activate('KF-TEST-LICENSE-KEY');
    expect(activateResult).toEqual({ expiresAt: claims1.expiresAt });

    await expect(client.getEntitlement()).resolves.toEqual({
      status: 'valid',
      expiresAt: claims1.expiresAt,
      featureIds: claims1.featureIds,
      features: claims1.features,
    });

    const fingerprint = await storage.get('installationFingerprint');
    expect(typeof fingerprint).toBe('string');
    expect(fingerprint.length).toBeGreaterThan(0);

    now = t0 + 500;
    await expect(client.refresh()).resolves.toEqual({
      status: 'updated',
      expiresAt: claims2.expiresAt,
    });

    // Proves refresh() and getEntitlement() read/write the same storage
    // instance through the composed client, not two independently
    // configured pieces that only happen to look alike.
    await expect(client.getEntitlement()).resolves.toEqual({
      status: 'valid',
      expiresAt: claims2.expiresAt,
      featureIds: claims2.featureIds,
      features: claims2.features,
    });

    await expect(client.deactivate()).resolves.toBeUndefined();
    await expect(client.getEntitlement()).resolves.toEqual({ status: 'not_activated' });

    // installationFingerprint is device identity, not activation state —
    // must survive deactivate() unchanged.
    await expect(storage.get('installationFingerprint')).resolves.toBe(fingerprint);
  });

  it('propagates a server-reported revocation from refresh() through to getEntitlement() via shared storage', async () => {
    const storage = createMemoryAdapter();
    const { response: activateResp } = await activationResponse();
    const fetchImpl = queueFetch([
      activateResp,
      jsonResponse(403, {
        error: { code: 'LICENSE_REVOKED', message: 'License has been revoked' },
      }),
    ]);

    const client = await createKeyforgeClient({
      storage,
      publicKeys: { 1: keyPair.publicKeyPem },
      baseUrl: BASE_URL,
      fetchImpl,
    });

    await client.activate('KF-TEST-LICENSE-KEY');
    await expect(client.getEntitlement()).resolves.toMatchObject({ status: 'valid' });

    await expect(client.refresh()).resolves.toEqual({ status: 'revoked' });
    await expect(client.getEntitlement()).resolves.toEqual({ status: 'revoked' });
  });

  it('rejects construction when a required field (publicKeys) is missing', async () => {
    await expect(
      createKeyforgeClient({ storage: createMemoryAdapter(), baseUrl: BASE_URL }),
    ).rejects.toThrow();
  });

  it('defaults storage to a real JSON-file adapter at the default path when omitted', async () => {
    const originalCwd = process.cwd();
    const tempDir = await mkdtemp(path.join(tmpdir(), 'keyforge-client-index-test-'));
    process.chdir(tempDir);

    try {
      const { response: activateResp, claims } = await activationResponse();
      const fetchImpl = queueFetch([activateResp]);

      const client = await createKeyforgeClient({
        publicKeys: { 1: keyPair.publicKeyPem },
        baseUrl: BASE_URL,
        fetchImpl,
      });

      await client.activate('KF-TEST-LICENSE-KEY');
      await expect(client.getEntitlement()).resolves.toMatchObject({
        status: 'valid',
        expiresAt: claims.expiresAt,
      });

      const stateFilePath = path.join(tempDir, '.keyforge-client', 'state.json');
      const state = JSON.parse(await readFile(stateFilePath, 'utf8'));
      expect(typeof state.entitlementToken).toBe('string');
    } finally {
      process.chdir(originalCwd);
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
