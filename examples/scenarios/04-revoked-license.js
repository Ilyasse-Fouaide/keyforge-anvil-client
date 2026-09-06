#!/usr/bin/env node
// examples/scenarios/04-revoked-license.js — revokes the license via the
// admin API mid-scenario, then refresh(), then getEntitlement() reporting
// 'revoked'. Requires 01-first-activation.js to have run first.

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
  const config = loadConfig();

  console.log(`Revoking license ${fixtures.licenseId} via the admin API...`);
  const session = await createAdminSession({
    baseUrl: config.baseUrl,
    email: config.adminEmail,
    password: config.adminPassword,
  });
  const license = await setLicenseStatus(session, fixtures.licenseId, 'revoked');
  console.log(`License status is now '${license.status}'.`);
  check(license.status === 'revoked', 'admin API confirms the license is revoked');

  const client = await createKeyforgeClient({
    baseUrl: fixtures.baseUrl,
    publicKeys,
    storage: createJsonFileAdapter({ filePath: statePath }),
  });

  const refreshResult = await client.refresh();
  console.log(`refresh() -> ${JSON.stringify(refreshResult)}`);
  check(
    refreshResult.status === 'revoked',
    `refresh() reports 'revoked' without throwing (got '${refreshResult.status}')`,
  );

  const entitlement = await client.getEntitlement();
  console.log(`getEntitlement() -> ${JSON.stringify(entitlement)}`);
  check(
    entitlement.status === 'revoked',
    `getEntitlement() reports 'revoked' (got '${entitlement.status}')`,
  );
});
