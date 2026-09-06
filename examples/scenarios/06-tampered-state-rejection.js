#!/usr/bin/env node
// examples/scenarios/06-tampered-state-rejection.js — corrupts the real
// on-disk state.json directly (simulating tampering, not using any internal
// API), confirms getEntitlement() reports 'tampered', not a crash. Requires
// 05-deactivate-and-reactivate.js to have run first. Deliberately the last
// scenario: it leaves the entitlementToken unusable, which is why it's
// numbered last in this shared-installation narrative (see
// examples/README.md). installationToken is left untouched so
// teardown-fixtures.js can still cleanly deactivate afterward.

import { readFile, writeFile } from 'node:fs/promises';

import { createKeyforgeClient } from 'keyforge-anvil-client';

import { createJsonFileAdapter } from '../../src/storage/json-file.js';
import { statePath } from '../lib/paths.js';
import { check, loadFixtures, loadPublicKeys, requireExistingState, run } from '../lib/scenario.js';

// Mutates one character in the JWS's signature segment. Keeps the file valid
// JSON and the token superficially JWS-shaped (still base64url, still three
// dot-separated segments) — this specifically exercises signature-tamper
// detection, not the separately-tested "corrupted JSON throws" path (Phase 1).
function flipOneCharacter(jws) {
  const segments = jws.split('.');
  const signature = segments[2];
  const midpoint = Math.floor(signature.length / 2);
  const replacement = signature[midpoint] === 'A' ? 'B' : 'A';
  segments[2] = signature.slice(0, midpoint) + replacement + signature.slice(midpoint + 1);
  return segments.join('.');
}

run(async () => {
  await requireExistingState('01-first-activation.js');
  const fixtures = await loadFixtures();
  const publicKeys = await loadPublicKeys(fixtures);

  // Plain fs, deliberately not the StorageAdapter or any keyforge-anvil-client
  // API — this simulates an external party tampering with the file directly.
  const stateBefore = JSON.parse(await readFile(statePath, 'utf8'));
  check(
    typeof stateBefore.entitlementToken === 'string',
    'a stored entitlementToken exists to tamper with',
  );

  const tampered = {
    ...stateBefore,
    entitlementToken: flipOneCharacter(stateBefore.entitlementToken),
  };
  check(
    tampered.entitlementToken !== stateBefore.entitlementToken,
    'the on-disk entitlementToken was mutated',
  );
  await writeFile(statePath, JSON.stringify(tampered, null, 2));

  const client = await createKeyforgeClient({
    baseUrl: fixtures.baseUrl,
    publicKeys,
    storage: createJsonFileAdapter({ filePath: statePath }),
  });

  const entitlement = await client.getEntitlement();
  console.log(`getEntitlement() -> ${JSON.stringify(entitlement)}`);
  check(
    entitlement.status === 'tampered',
    `getEntitlement() reports 'tampered', not a crash (got '${entitlement.status}')`,
  );
});
