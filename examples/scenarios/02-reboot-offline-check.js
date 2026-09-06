#!/usr/bin/env node
// examples/scenarios/02-reboot-offline-check.js — simulates an app restart: a
// NEW process loading purely from disk and calling getEntitlement() with no
// network involved, proving the offline path actually works (not just the
// happy-path-in-one-process case). Requires 01-first-activation.js to have
// run first — that's the "before the reboot" half of this story.
//
// The "new process" claim is real, not simulated: this script is invoked as
// its own separate `node` command (by a human, or by run-all.js spawning it
// as a child process) — never imported and called in-process alongside 01.

import { createKeyforgeClient } from 'keyforge-anvil-client';

import { createJsonFileAdapter } from '../../src/storage/json-file.js';
import { statePath } from '../lib/paths.js';
import { check, loadFixtures, loadPublicKeys, requireExistingState, run } from '../lib/scenario.js';

run(async () => {
  await requireExistingState('01-first-activation.js');
  const fixtures = await loadFixtures();
  const publicKeys = await loadPublicKeys(fixtures);

  // Fresh adapter + fresh client instance, deliberately not reused from any
  // prior script — this is what "cold load from disk" actually means here.
  const client = await createKeyforgeClient({
    baseUrl: fixtures.baseUrl,
    publicKeys,
    storage: createJsonFileAdapter({ filePath: statePath }),
    // Belt-and-suspenders proof that this check never touches the network:
    // getEntitlement() never calls fetchImpl by design, but pointing it at a
    // throwing stub makes that guarantee actively enforced, not just assumed.
    fetchImpl: () => {
      throw new Error('network should not be reachable from getEntitlement()');
    },
  });

  const entitlement = await client.getEntitlement();
  console.log(`getEntitlement() -> ${JSON.stringify(entitlement)}`);
  check(
    entitlement.status === 'valid',
    `getEntitlement() reports 'valid' purely from disk, no network call made (got '${entitlement.status}')`,
  );
});
