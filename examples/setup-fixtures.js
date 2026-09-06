#!/usr/bin/env node
// examples/setup-fixtures.js — bootstraps everything the scenarios need
// against a real running keyforge-anvil server: a Feature/Customer/
// Subscription/License chain (name-prefixed "KAC Example" so it's
// identifiable and safe to sweep from a real dev database), plus confirms
// the signing public key is readable. Re-runnable from scratch: sweeps any
// stale "KAC Example"-prefixed fixtures left by an interrupted prior run
// before creating fresh ones — see examples/README.md.

import { createPublicKey } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import {
  createAdminSession,
  createCustomer,
  createFeature,
  createLicense,
  createSubscription,
  sweepFixtures,
} from './lib/adminApiClient.js';
import { loadConfig } from './lib/env.js';
import { fixturesPath, stateDir, statePath } from './lib/paths.js';

const PREFIX = 'KAC Example';

async function main() {
  // Unique per run: once a License is activated, keyforge-anvil's admin API has
  // no way to ever delete it or its Feature/Customer/Subscription chain (see the
  // sweepFixtures() comment in lib/adminApiClient.js) — a fixed slug would
  // collide with that permanent residue on a second run. The shared "KAC
  // Example" prefix still lets sweepFixtures() find every run's rows.
  const runId = Date.now();
  const config = loadConfig();

  console.log(`Connecting to keyforge-anvil admin API at ${config.baseUrl} ...`);
  const session = await createAdminSession({
    baseUrl: config.baseUrl,
    email: config.adminEmail,
    password: config.adminPassword,
  });
  console.log(`Authenticated as ${config.adminEmail}.`);

  console.log('Sweeping any stale fixtures from a prior run...');
  await sweepFixtures(session, { prefix: PREFIX });

  console.log(`Validating signing public key at ${config.publicKeyPath} ...`);
  const publicKeyPem = await readFile(config.publicKeyPath, 'utf8');
  createPublicKey({ key: publicKeyPem, format: 'pem' }); // throws if not a valid public key PEM
  console.log(`Public key OK (keyVersion ${config.keyVersion}).`);

  console.log('Creating fixtures...');
  const feature = await createFeature(session, {
    name: `${PREFIX} Feature ${runId}`,
    slug: `kac-example-${runId}`,
    description: 'Created by keyforge-anvil-client/examples/setup-fixtures.js',
  });
  const customer = await createCustomer(session, {
    name: `${PREFIX} Customer ${runId}`,
    contactEmail: 'kac-example@example.invalid',
  });
  const startDate = new Date();
  const endDate = new Date(startDate.getTime() + 365 * 24 * 60 * 60 * 1000);
  const subscription = await createSubscription(session, {
    customerId: customer.id,
    features: [feature.id],
    status: 'active',
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString(),
    gracePeriodDays: 14,
  });
  const license = await createLicense(session, {
    subscriptionId: subscription.id,
    maxActivations: 3,
  });

  await mkdir(stateDir, { recursive: true });
  await rm(statePath, { force: true }); // scenario 01 must start from a genuinely fresh install

  const fixtures = {
    baseUrl: config.baseUrl,
    publicKeyPath: config.publicKeyPath,
    keyVersion: config.keyVersion,
    featureId: feature.id,
    featureSlug: feature.slug,
    featureIds: [feature.id],
    customerId: customer.id,
    subscriptionId: subscription.id,
    licenseId: license.id,
    licenseKey: license.licenseKey,
  };
  await writeFile(fixturesPath, JSON.stringify(fixtures, null, 2));

  console.log('');
  console.log('Fixtures ready:');
  console.log(`  Feature:      ${feature.id} (${feature.slug})`);
  console.log(`  Customer:     ${customer.id}`);
  console.log(`  Subscription: ${subscription.id}`);
  console.log(`  License:      ${license.id}`);
  console.log(`  License key:  ${license.licenseKey}`);
  console.log(`  Public key:   ${config.publicKeyPath} (version ${config.keyVersion})`);
  console.log('');
  console.log('Run the scenarios in order, e.g.: node examples/scenarios/01-first-activation.js');
}

main().catch((err) => {
  console.error(`setup-fixtures.js failed: ${err.message}`);
  process.exitCode = 1;
});
