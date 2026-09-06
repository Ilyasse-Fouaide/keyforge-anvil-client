#!/usr/bin/env node
// examples/teardown-fixtures.js — cleans up everything setup-fixtures.js
// created (plus any stale "KAC Example"-prefixed leftovers from a crashed
// prior run), respecting the admin API's dependents-guard delete order:
// License -> Subscription -> Customer -> Feature. See
// examples/lib/adminApiClient.js's sweepFixtures() for the actual logic.

import { rm } from 'node:fs/promises';

import { createAdminSession, sweepFixtures } from './lib/adminApiClient.js';
import { loadConfig } from './lib/env.js';
import { fixturesPath, statePath } from './lib/paths.js';

const PREFIX = 'KAC Example';

async function main() {
  const config = loadConfig();

  console.log(`Connecting to keyforge-anvil admin API at ${config.baseUrl} ...`);
  const session = await createAdminSession({
    baseUrl: config.baseUrl,
    email: config.adminEmail,
    password: config.adminPassword,
  });

  console.log('Sweeping fixtures...');
  await sweepFixtures(session, { prefix: PREFIX });

  await rm(fixturesPath, { force: true });
  await rm(statePath, { force: true });

  console.log('');
  console.log('Teardown complete.');
}

main().catch((err) => {
  console.error(`teardown-fixtures.js failed: ${err.message}`);
  process.exitCode = 1;
});
