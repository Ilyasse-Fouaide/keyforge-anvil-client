#!/usr/bin/env node
// examples/scenarios/01-first-activation.js — activate() + getEntitlement()
// on a fresh install. First step of the shared-installation narrative (see
// examples/README.md): every later scenario builds on the on-disk state this
// one creates at examples/.state/state.json.

import { createKeyforgeClient } from 'keyforge-anvil-client';

// Imported by relative path (also re-exported from the package entry point) —
// used here only to point the harness at examples/.state/state.json instead of
// the library's own default `.keyforge-client/` path.
import { createJsonFileAdapter } from '../../src/storage/json-file.js';
import { statePath } from '../lib/paths.js';
import { check, loadFixtures, loadPublicKeys, run } from '../lib/scenario.js';

run(async () => {
  const fixtures = await loadFixtures();
  const publicKeys = await loadPublicKeys(fixtures);

  const client = await createKeyforgeClient({
    baseUrl: fixtures.baseUrl,
    publicKeys,
    storage: createJsonFileAdapter({ filePath: statePath }),
  });

  const activateResult = await client.activate(fixtures.licenseKey);
  console.log(`activate() -> ${JSON.stringify(activateResult)}`);
  check(
    typeof activateResult.expiresAt === 'number',
    'activate() resolves with a numeric expiresAt',
  );

  const entitlement = await client.getEntitlement();
  console.log(`getEntitlement() -> ${JSON.stringify(entitlement)}`);
  check(
    entitlement.status === 'valid',
    `getEntitlement() reports 'valid' on a fresh activation (got '${entitlement.status}')`,
  );
  check(
    Array.isArray(entitlement.featureIds) && entitlement.featureIds.includes(fixtures.featureId),
    `getEntitlement() surfaces the licensed featureIds array including ${fixtures.featureId} ` +
      `(got ${JSON.stringify(entitlement.featureIds)})`,
  );
});
