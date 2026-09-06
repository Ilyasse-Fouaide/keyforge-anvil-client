# keyforge-anvil-client examples

A runnable verification suite that exercises `keyforge-anvil-client` against a
real, running keyforge-anvil server — not mocks. Two purposes: confidence-building
(does this actually work end to end?) and living integration documentation for
whoever wires this module into the real menu platform later.

This is additive tooling, not one of `ARCHITECTURE.md` §13's four implementation
phases — see `PROGRESS.md`.

## How it's structured

Six scenarios simulate **one branch installation's lifecycle**, run in order
against a single shared on-disk state file (`examples/.state/state.json`):

| # | Scenario | What it proves |
|---|---|---|
| 01 | `first-activation` | `activate()` + `getEntitlement()` on a fresh install; the `valid` result surfaces the licensed `featureIds` array |
| 02 | `reboot-offline-check` | A brand-new process, loading purely from disk, still reports `valid` — no network involved |
| 03 | `background-refresh` | `refresh()` against the live server actually advances the on-disk watermarks |
| 04 | `revoked-license` | Revoking via the admin API, then `refresh()`, makes `getEntitlement()` report `revoked` |
| 05 | `deactivate-and-reactivate` | `deactivate()` clears state but keeps `installationFingerprint`; re-`activate()` reuses it |
| 06 | `tampered-state-rejection` | Directly corrupting `state.json` on disk makes `getEntitlement()` report `tampered`, not crash |

They run in this order **on purpose** — each one builds on the state the previous
one left on disk (06 is deliberately last, since it leaves the entitlement token
unusable). Each script is still independently runnable as its own `node` command;
if you run one before its prerequisite, it exits with a clear "run `0N-...js`
first" message rather than a confusing crash.

## Prerequisites

1. **A running keyforge-anvil server + MongoDB.** In your keyforge-anvil checkout:
   ```
   docker compose up -d mongo   # or point MONGODB_URI at any local mongod
   npm run dev                  # API on http://localhost:3000
   ```
2. **A generated signing keypair**, in that same checkout, if one doesn't already
   exist:
   ```
   npm run generate-signing-keypair -- --version 1
   ```
   This writes `keys/private-v1.pem` (used by the server) and `keys/public-v1.pem`
   (what this suite needs — see below), plus a `keys/public-keys.json` manifest.
3. **Admin credentials.** No special bootstrap step is required — just pick an
   email/password (password ≥ 12 chars) for `examples/.env` below.
   `setup-fixtures.js` will register that admin automatically if the server's
   database has none yet, or log in with it if one already exists.

## Configuration

```
cp examples/.env.example examples/.env
```

Then edit `examples/.env`:

| Var | Meaning |
|---|---|
| `KEYFORGE_BASE_URL` | Server origin, default `http://localhost:3000`. |
| `KEYFORGE_ADMIN_EMAIL` / `KEYFORGE_ADMIN_PASSWORD` | Bootstraps the first admin, or logs into an existing one. Password ≥ 12 chars. |
| `KEYFORGE_PUBLIC_KEY_PATH` | Path to your keyforge-anvil checkout's `keys/public-v1.pem`. Not committed to this repo, not a shared value — point it at wherever you cloned the server. |
| `KEYFORGE_KEY_VERSION` | Default `1`. Must match the server's `LICENSE_SIGNING_KEY_VERSION`. |

## Running it

**Everything, one command:**

```
npm run examples:run-all
```

Runs `setup-fixtures.js`, all six scenarios in order, then
`teardown-fixtures.js`, and prints a pass/fail summary. Safe to re-run
immediately afterward — setup sweeps any stale fixtures before creating new ones.

**Step by step**, to read each scenario's output as you go:

```
npm run examples:setup
node examples/scenarios/01-first-activation.js
node examples/scenarios/02-reboot-offline-check.js
node examples/scenarios/03-background-refresh.js
node examples/scenarios/04-revoked-license.js
node examples/scenarios/05-deactivate-and-reactivate.js
node examples/scenarios/06-tampered-state-rejection.js
npm run examples:teardown
```

## What `setup-fixtures.js` does

Creates a `Feature` → `Customer` → `Subscription` → `License` chain via the admin
API. keyforge-anvil collapsed the old Product + Plan model into a flat `Feature`
catalog (the dashboard still labels it "Products", but the route/model are
`features`), so a `Subscription` names an explicit set of Feature ids
(`features: [featureId]`) plus a required `gracePeriodDays` — there is no Plan to
copy defaults from, and no `/api/v1/admin/plans` endpoint. Everything is
named/slugged with a `KAC Example` prefix plus a per-run timestamp (see the
residue note below for why) so it's identifiable and safe to run against a real
dev database — nothing else gets touched. Captures the License's
one-time-disclosed `licenseKey`, validates `KEYFORGE_PUBLIC_KEY_PATH` is a real
public key PEM, and writes both (plus the created `featureId`/`featureIds`) to
`examples/.state/fixtures.json` for the scenarios to read. Before creating
anything, it sweeps away any `KAC Example`-prefixed fixtures already present that
the admin API will still allow deleting (see below). Expected output ends with:

```
Fixtures ready:
  Feature:      <id> (kac-example-1786751136004)
  Customer:     <id>
  Subscription: <id>
  License:      <id>
  License key:  KF-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-CCCC
  Public key:   /path/to/keys/public-v1.pem (version 1)
```

## What `teardown-fixtures.js` does

The same name-prefix sweep, run as actual cleanup: deactivates the recorded
installation (if any), then attempts to delete License → Subscription → Customer
→ Feature in the order the admin API's dependents-guard requires, and removes
`examples/.state/`. Safe to run even if a prior run crashed partway — it
discovers fixtures by name, not by trusting a particular run's IDs.

### A confirmed, permanent limitation: activated fixtures can't be deleted

Verified end to end against a real server, not assumed: **once a License has been
activated even once, neither it nor anything upstream of it (its Subscription,
Customer, Feature) can ever be deleted through the admin API.** `deactivate()`
only marks the server's Activation record `'deactivated'` — it's never removed —
and the delete-guard's dependents check counts Activation rows regardless of
status. There is no admin route to delete an Activation directly. Since every
scenario run activates the fixture license (that's the whole point), **every full
run of this suite leaves its `Feature`/`Customer`/`Subscription`/`License` chain
permanently in your keyforge-anvil dev database** — `teardown-fixtures.js`
reports this plainly (`Not deleted (HAS_DEPENDENTS): ...` per row, then a summary
note) rather than treating it as a failure.

This is the same category of thing as keyforge-anvil's own `ApiKey` (revoke-only,
no delete) and `AuditLog` (no delete at all) rows — expected, permanent, and
already accepted in that repo's own `VERIFICATION.md`. It's why
`setup-fixtures.js` suffixes every fixture's name/slug with a timestamp
(`kac-example-<runId>`) instead of reusing a fixed one: a fixed slug would
collide with the previous run's now-undeletable `Feature`, breaking
re-runnability entirely. All residue still shares the `KAC Example` prefix, so it
stays easy to identify (and query) later if you ever want to survey how much of
it has accumulated.

## Expected output, scenario by scenario

Each scenario prints `PASS <check>` / `FAIL <check>` lines (and exits nonzero on
any failure), plus the raw `activate()`/`getEntitlement()`/etc. results it
observed. For example, `01-first-activation.js`:

```
activate() -> {"expiresAt":1234567890}
PASS activate() resolves with a numeric expiresAt
getEntitlement() -> {"status":"valid","expiresAt":1234567890,"featureIds":["<id>"],"features":{"maxBranches":3}}
PASS getEntitlement() reports 'valid' on a fresh activation (got 'valid')
PASS getEntitlement() surfaces the licensed featureIds array including <id>

All checks passed.
```

`03-background-refresh.js` additionally prints a before/after snapshot of the raw
stored watermarks, so you can see `highestIssuedAtSeen` and `lastValidatedAt`
advance and `entitlementToken` change in place.

`05-deactivate-and-reactivate.js` logs the `installationFingerprint` value before
and after, confirming it's identical across `deactivate()` → `activate()` — and
logs the un-revoke admin-API call it makes first (see note below).

## A note on scenario 05's un-revoke step

Scenario 04 leaves the fixture license revoked. The server's own error table
blocks `activate()` on a revoked license (`LICENSE_REVOKED`, 403) the same as it
blocks `refresh()`/`validate()` — so scenario 05 restores the license to `active`
via the admin API before calling `activate()` again. This is also a realistic
real-world sequence (an admin lifts a revocation, the branch reactivates), not
just a workaround.

## Revocation propagation

Per `README.md` (this repo's own, not this file) and keyforge-anvil's own
architecture: `getEntitlement()` runs entirely offline and cannot know about a
revocation that happened after the last successful `refresh()`. Scenario 04
demonstrates the *detection* path (revoke → `refresh()` → `getEntitlement()`
reports `revoked`) — it does not, and can't, demonstrate instant/offline
revocation, since that's not how this system is designed to work.

## Troubleshooting

- **`REGISTRATION_CLOSED` error from `setup-fixtures.js`**: an admin account
  already exists on the target server and doesn't match
  `KEYFORGE_ADMIN_EMAIL`/`KEYFORGE_ADMIN_PASSWORD`. Either fix `examples/.env` to
  match it, or in your keyforge-anvil checkout run
  `npm run create-admin -- <email>` (password via stdin) to create a fresh one,
  or `npm run delete-admin -- <existing-email>` to remove a stale one.
- **`UNREACHABLE` / connection errors**: the keyforge-anvil server isn't running
  at `KEYFORGE_BASE_URL`, or MongoDB isn't up. See Prerequisites above.
- **`docker compose up -d mongo` fails with a port-already-in-use error**: you
  (or another project) already have a `mongod` listening on `27017` — that's
  fine, this suite doesn't care which Mongo it is. Just point the keyforge-anvil
  checkout's `MONGODB_URI` at it and skip the `docker compose` step.
- **`Not deleted (HAS_DEPENDENTS)` lines from `teardown-fixtures.js`**: this is
  expected once fixtures have been activated, not an error — see "A confirmed,
  permanent limitation" above.
- **Errors reading `KEYFORGE_PUBLIC_KEY_PATH`**: confirm the path exists and
  points at a `public-v<N>.pem` file from your keyforge-anvil checkout's `keys/`
  directory (run `npm run generate-signing-keypair -- --version 1` there if it's
  missing), and that `KEYFORGE_KEY_VERSION` matches its `<N>` and the server's
  own `LICENSE_SIGNING_KEY_VERSION`.
- **"run `0N-...js` first" errors**: you ran a scenario out of order, or against
  a `.state/` left over from a different run. Start over with
  `npm run examples:setup` and run scenarios 01→06 in order (or just use
  `npm run examples:run-all`).
