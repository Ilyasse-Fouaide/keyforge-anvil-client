#!/usr/bin/env node
// examples/scenarios/05-deactivate-and-reactivate.js — deactivate(), confirm
// not_activated, confirm installationFingerprint survived, activate() again.
// Requires 04-revoked-license.js to have run first.
//
// One necessary addition beyond the literal scenario description: the
// server's error table blocks activate() on a revoked license (LICENSE_
// REVOKED, 403), and 04 left this fixture's license revoked. Without
// restoring it first, the final activate() below would fail — so this
// scenario un-revokes via the admin API before reactivating, modeling a
// realistic sequence too (admin restores a license, branch reactivates).

import { createKeyforgeClient } from 'keyforge-anvil-client';

import { createAdminSession, setLicenseStatus } from '../lib/adminApiClient.js';
import { loadConfig } from '../lib/env.js';
import { createJsonFileAdapter } from '../../src/storage/json-file.js';
import { statePath } from '../lib/paths.js';
import { check, loadFixtures, loadPublicKeys, requireExistingState, run } from '../lib/scenario.js';

run(async () => {
  await requireExistingState('01-first-activation.js');
  const fixtures = await loadFixtures();
  const publicKeys = await loadPublicKeys(fixtures);

  const storage = createJsonFileAdapter({ filePath: statePath });
  const client = await createKeyforgeClient({
    baseUrl: fixtures.baseUrl,
    publicKeys,
    storage,
  });

  const fingerprintBefore = await storage.get('installationFingerprint');
  check(
    typeof fingerprintBefore === 'string' && fingerprintBefore.length > 0,
    'installationFingerprint exists before deactivate()',
  );

  await client.deactivate();
  console.log('deactivate() complete.');

  const afterDeactivate = await client.getEntitlement();
  console.log(`getEntitlement() -> ${JSON.stringify(afterDeactivate)}`);
  check(
    afterDeactivate.status === 'not_activated',
    `getEntitlement() reports 'not_activated' after deactivate() (got '${afterDeactivate.status}')`,
  );

  const fingerprintAfter = await storage.get('installationFingerprint');
  console.log(`installationFingerprint -> ${fingerprintAfter}`);
  check(fingerprintAfter === fingerprintBefore, 'installationFingerprint survived deactivate()');

  const config = loadConfig();
  console.log(`Un-revoking license ${fixtures.licenseId} via the admin API...`);
  const session = await createAdminSession({
    baseUrl: config.baseUrl,
    email: config.adminEmail,
    password: config.adminPassword,
  });
  const license = await setLicenseStatus(session, fixtures.licenseId, 'active');
  check(license.status === 'active', 'admin API confirms the license is active again');

  const activateResult = await client.activate(fixtures.licenseKey);
  console.log(`activate() -> ${JSON.stringify(activateResult)}`);

  const fingerprintFinal = await storage.get('installationFingerprint');
  check(
    fingerprintFinal === fingerprintBefore,
    're-activation reused the same installationFingerprint',
  );

  const finalEntitlement = await client.getEntitlement();
  console.log(`getEntitlement() -> ${JSON.stringify(finalEntitlement)}`);
  check(
    finalEntitlement.status === 'valid',
    `getEntitlement() reports 'valid' after reactivation (got '${finalEntitlement.status}')`,
  );
});
