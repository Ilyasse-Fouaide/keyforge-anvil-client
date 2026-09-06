// Thin admin-API HTTP client for the examples/ fixture tooling: cookie-session
// auth (login, falling back to one-time bootstrap registration), CRUD helpers
// for keyforge-anvil's Feature/Customer/Subscription/License chain, and a
// name-prefix sweep used by both setup-fixtures.js (clean slate before creating)
// and teardown-fixtures.js (actual cleanup) — mirrors the keyforge-anvil server
// repo's own "PW-prefix + before/and-after sweep" convention from its
// VERIFICATION.md / e2e tooling, applied here to a real admin API instead of a
// browser UI.
//
// keyforge-anvil collapsed the old Product + Plan model into a flat `Feature`
// catalog: there is no `/api/v1/admin/plans` endpoint, and a Subscription now
// names an explicit set of Feature ids (`features: [FeatureId, ...]`) plus a
// required `gracePeriodDays`. See ../keyforge-anvil/ARCHITECTURE.md §10.

import { readFile } from 'node:fs/promises';

import { createKeyforgeClient } from 'keyforge-anvil-client';

// Imported by relative path (it is also re-exported from the package entry
// point) — used here only to point the harness's cleanup client at the same
// on-disk state file the scenarios wrote to.
import { createJsonFileAdapter } from '../../src/storage/json-file.js';
import { fixturesPath, statePath } from './paths.js';

export class AdminApiError extends Error {
  constructor(status, code, message, options = {}) {
    super(message ?? `Admin API error (${code})`, { cause: options.cause });
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    this.details = options.details;
  }
}

/**
 * Logs in as the given admin, bootstrapping (registering) the first admin
 * account if login fails because none exists yet. Returns a session object
 * exposing `request(method, path, body)` for every subsequent admin call.
 */
export async function createAdminSession({ baseUrl, email, password, fetchImpl = fetch }) {
  let cookie = null;

  function captureCookie(response) {
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
  }

  async function rawPost(requestPath, body) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${requestPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new AdminApiError(
        0,
        'UNREACHABLE',
        `Could not reach the keyforge-anvil server at ${baseUrl} — is it running? ` +
          `(npm run dev, or npm run dev:all, in your keyforge-anvil checkout)`,
        { cause: err },
      );
    }
    let body_ = null;
    try {
      body_ = await response.json();
    } catch {
      // no/invalid JSON body — tolerated, callers check response.status first
    }
    return { response, body: body_ };
  }

  const login = await rawPost('/api/v1/admin/auth/login', { email, password });
  if (login.response.status === 200) {
    captureCookie(login.response);
  } else if (login.response.status === 401) {
    const register = await rawPost('/api/v1/admin/auth/register', { email, password });
    if (register.response.status === 201) {
      captureCookie(register.response);
    } else if (register.response.status === 403) {
      throw new AdminApiError(
        403,
        'REGISTRATION_CLOSED',
        `Login failed for ${email}, and registration is closed (an admin account already ` +
          `exists on this server that doesn't match KEYFORGE_ADMIN_EMAIL/KEYFORGE_ADMIN_PASSWORD). ` +
          `Fix examples/.env, or in your keyforge-anvil checkout run ` +
          `"npm run create-admin -- ${email}" (password via stdin) to create it, or ` +
          `"npm run delete-admin -- <existing-email>" to remove a stale admin first.`,
      );
    } else {
      throw new AdminApiError(
        register.response.status,
        register.body?.error?.code ?? 'UNKNOWN_ERROR',
        register.body?.error?.message ?? 'Admin registration failed unexpectedly.',
      );
    }
  } else {
    throw new AdminApiError(
      login.response.status,
      login.body?.error?.code ?? 'UNKNOWN_ERROR',
      login.body?.error?.message ?? 'Admin login failed unexpectedly.',
    );
  }

  async function request(method, requestPath, body) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${requestPath}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(cookie ? { cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new AdminApiError(
        0,
        'UNREACHABLE',
        `Could not reach the keyforge-anvil server at ${baseUrl}.`,
        { cause: err },
      );
    }

    if (response.status >= 200 && response.status < 300) {
      if (response.status === 204) return null;
      try {
        return await response.json();
      } catch {
        return null;
      }
    }

    let errBody = null;
    try {
      errBody = await response.json();
    } catch {
      // tolerate a missing/invalid error body on an already-exceptional path
    }
    throw new AdminApiError(
      response.status,
      errBody?.error?.code ?? 'UNKNOWN_ERROR',
      errBody?.error?.message ?? `Admin API request failed: ${method} ${requestPath}`,
      { details: errBody?.error?.details },
    );
  }

  return { baseUrl, request };
}

// --- CRUD helpers -----------------------------------------------------

// keyforge-anvil's licensable catalog is a flat `Feature` (the dashboard labels
// it "Products", but the route/model/permissions are all `features`).
export async function createFeature(session, { name, slug, description }) {
  const { data } = await session.request('POST', '/api/v1/admin/features', {
    name,
    slug,
    description,
  });
  return data;
}

export async function createCustomer(session, { name, contactEmail }) {
  const { data } = await session.request('POST', '/api/v1/admin/customers', {
    name,
    contactEmail,
  });
  return data;
}

export async function createSubscription(
  session,
  { customerId, features, status, startDate, endDate, gracePeriodDays },
) {
  const { data } = await session.request('POST', '/api/v1/admin/subscriptions', {
    customerId,
    features, // array of Feature ids (>= 1) — replaces the old productId/planId
    status,
    startDate,
    endDate,
    gracePeriodDays, // required: no Plan to default it from anymore
  });
  return data;
}

export async function createLicense(session, { subscriptionId, maxActivations }) {
  const { data } = await session.request('POST', '/api/v1/admin/licenses', {
    subscriptionId,
    maxActivations,
  });
  return data;
}

export async function setLicenseStatus(session, licenseId, status) {
  const { data } = await session.request('PATCH', `/api/v1/admin/licenses/${licenseId}`, {
    status,
  });
  return data;
}

export async function deleteFeature(session, id) {
  await session.request('DELETE', `/api/v1/admin/features/${id}`);
}
export async function deleteCustomer(session, id) {
  await session.request('DELETE', `/api/v1/admin/customers/${id}`);
}
export async function deleteSubscription(session, id) {
  await session.request('DELETE', `/api/v1/admin/subscriptions/${id}`);
}
export async function deleteLicense(session, id) {
  await session.request('DELETE', `/api/v1/admin/licenses/${id}`);
}

// The admin list endpoints support advanced `filters` query params, but the
// filter-field ids are coupled to each resource's own *_FILTER_FIELDS config
// (which already broke this tooling once upstream). For a bounded dev database
// it's more robust to pull a page and filter client-side on the returned docs.
export async function listFeatures(session) {
  const { data } = await session.request('GET', '/api/v1/admin/features?limit=100');
  return data;
}
export async function listCustomers(session) {
  const { data } = await session.request('GET', '/api/v1/admin/customers?limit=100');
  return data;
}
export async function listSubscriptionsByCustomer(session, customerId) {
  const { data } = await session.request('GET', '/api/v1/admin/subscriptions?limit=100');
  return data.filter((s) => String(s.customerId) === String(customerId));
}
export async function listLicensesBySubscription(session, subscriptionId) {
  const { data } = await session.request('GET', '/api/v1/admin/licenses?limit=100');
  return data.filter((l) => String(l.subscriptionId) === String(subscriptionId));
}

// --- Sweep --------------------------------------------------------------

/**
 * Best-effort: if examples/.state/fixtures.json + state.json describe a live
 * installation, deactivate it via the real keyforge-anvil-client public API
 * first. Confirmed against a real server (not assumed): this does NOT free the
 * License delete-guard below — deactivating only marks the Activation record
 * 'deactivated', it is never deleted, and the guard's dependents query counts
 * Activations regardless of status. There is no admin route to delete an
 * Activation directly. So once a License has been activated even once, it — and
 * everything upstream of it in the Feature/Customer/Subscription chain — can
 * never be deleted through this API, ever. Deactivating first is still worth
 * doing anyway (it's the correct real-world cleanup step, and frees the
 * License's activation-slot count even though the row itself is permanent); see
 * the sweepFixtures() footer note below for how this is reported. Tolerates
 * every failure here (missing files, corrupted state, already deactivated).
 */
async function tryDeactivateStoredInstallation() {
  let fixtures;
  try {
    fixtures = JSON.parse(await readFile(fixturesPath, 'utf8'));
  } catch {
    return;
  }

  let state;
  try {
    state = JSON.parse(await readFile(statePath, 'utf8'));
  } catch {
    return;
  }
  if (!state.installationToken) return;

  try {
    const publicKeyPem = await readFile(fixtures.publicKeyPath, 'utf8');
    const client = await createKeyforgeClient({
      baseUrl: fixtures.baseUrl,
      publicKeys: { [fixtures.keyVersion]: publicKeyPem },
      storage: createJsonFileAdapter({ filePath: statePath }),
    });
    await client.deactivate();
    console.log('  Deactivated the recorded installation before deleting its license.');
  } catch (err) {
    console.warn(
      `  ! Could not auto-deactivate the recorded installation (${err.message}) — ` +
        `a delete below may fail with HAS_DEPENDENTS.`,
    );
  }
}

async function deleteWithWarning(deleteFn, label) {
  try {
    await deleteFn();
    console.log(`  Deleted ${label}`);
    return true;
  } catch (err) {
    // HAS_DEPENDENTS here is usually the permanent-residue case documented
    // on tryDeactivateStoredInstallation() above, not a real problem — the
    // sweepFixtures() footer note explains it once, so this stays quiet
    // (informational, not an alarming "!") to avoid crying wolf every run.
    console.log(`  Not deleted (${err.code ?? 'error'}): ${label} — ${err.message}`);
    return false;
  }
}

/**
 * Discovers every Feature/Customer whose name starts with `prefix`, walks the
 * dependents-guard-safe delete order (License -> Subscription -> Customer ->
 * Feature), and deletes as many as the admin API allows. Self-healing:
 * discovers by name rather than trusting any particular fixtures.json, so it
 * cleans up after a crashed prior run too.
 *
 * Confirmed against a real server: once any License in the discovered set has
 * ever been activated, it and its whole chain become permanently undeletable
 * (see tryDeactivateStoredInstallation() above) — this is expected, not a bug,
 * and is reported as a summary note rather than per-row alarm text.
 */
export async function sweepFixtures(session, { prefix }) {
  await tryDeactivateStoredInstallation();

  const [allFeatures, allCustomers] = await Promise.all([
    listFeatures(session),
    listCustomers(session),
  ]);
  const features = allFeatures.filter((f) => f.name.startsWith(prefix));
  const customers = allCustomers.filter((c) => c.name.startsWith(prefix));

  const subscriptions = (
    await Promise.all(
      customers.map((customer) => listSubscriptionsByCustomer(session, customer.id)),
    )
  ).flat();
  const licenses = (
    await Promise.all(
      subscriptions.map((subscription) => listLicensesBySubscription(session, subscription.id)),
    )
  ).flat();

  console.log(
    `Sweep found ${features.length} feature(s), ${customers.length} customer(s), ` +
      `${subscriptions.length} subscription(s), ${licenses.length} license(s) ` +
      `prefixed "${prefix}".`,
  );

  let notDeleted = 0;
  for (const license of licenses) {
    if (
      !(await deleteWithWarning(() => deleteLicense(session, license.id), `license ${license.id}`))
    )
      notDeleted += 1;
  }
  for (const subscription of subscriptions) {
    if (
      !(await deleteWithWarning(
        () => deleteSubscription(session, subscription.id),
        `subscription ${subscription.id}`,
      ))
    )
      notDeleted += 1;
  }
  for (const customer of customers) {
    if (
      !(await deleteWithWarning(
        () => deleteCustomer(session, customer.id),
        `customer ${customer.id}`,
      ))
    )
      notDeleted += 1;
  }
  for (const feature of features) {
    if (
      !(await deleteWithWarning(() => deleteFeature(session, feature.id), `feature ${feature.id}`))
    )
      notDeleted += 1;
  }

  if (notDeleted > 0) {
    console.log(
      `\nNote: ${notDeleted} row(s) above were not deleted. keyforge-anvil's admin API has no ` +
        `way to remove Activation history once a License has been activated (deactivate() only ` +
        `marks it inactive; there's no delete route for Activation records), so an activated ` +
        `License's entire fixture chain becomes permanent database residue — the same ` +
        `category as keyforge-anvil's own ApiKey/AuditLog rows, which also have no delete ` +
        `endpoint. This is expected, not a bug: each run uses a unique name/slug suffix (see ` +
        `setup-fixtures.js), so old residue never blocks a new run.`,
    );
  }
}
