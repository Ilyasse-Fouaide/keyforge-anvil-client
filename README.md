# keyforge-anvil-client

Offline-safe license client for keyforge-anvil-protected branch installations.

`keyforge-anvil-client` is a Node/ESM module that runs *inside* a branch's local
backend process to talk to keyforge-anvil (the licensing server, a separate
repo). It is not a browser client — no UI, no framework dependency. Local
Ed25519 signature verification is the fast, network-free path;
server contact (`activate`/`refresh`/`deactivate`) is one-time or
background. **The branch app must never block startup on a network call** —
`getEntitlement()` never makes one.

## Installation

```bash
npm install keyforge-anvil-client
```

## Quick start

```js
import { createKeyforgeClient } from 'keyforge-anvil-client';

const client = await createKeyforgeClient({
  publicKeys: { 1: process.env.KEYFORGE_PUBLIC_KEY_V1 },
  baseUrl: 'https://licensing.example.com',
});

// Once, human-initiated (e.g. from a setup wizard). Throws on failure.
await client.activate(licenseKey);

// On every app boot. Network-free, never throws for expected bad states.
const entitlement = await client.getEntitlement();
if (entitlement.status !== 'valid') {
  // degraded mode vs. hard stop is your app's call, not this module's
}

// Periodically in the background (e.g. every few hours). Never throws for
// "offline" — silently no-ops so it's safe to call on a timer.
setInterval(() => client.refresh(), 6 * 60 * 60 * 1000);

// Decommissioning a branch. Throws on failure.
await client.deactivate();
```

## Configuration

`createKeyforgeClient(config)` takes a single config object:

| Field | Required | Default | Notes |
|---|---|---|---|
| `publicKeys` | Yes | — | `{ [keyVersion]: pemString }`. keyforge-anvil's Ed25519 public key(s), keyed by `keyVersion` for rotation. Config, not hardcoded, so a server-side key rotation doesn't force a new release of this module. |
| `baseUrl` | Yes | — | keyforge-anvil server base URL, e.g. `https://licensing.example.com`. |
| `storage` | No | a JSON-file adapter at `<cwd>/.keyforge-client/state.json` | Any object implementing the `StorageAdapter` interface (`get`/`set`/`delete`, all `Promise`-returning). The default is a plain JSON file — no SQLite, no native-binary install friction. If your backend already manages its own database, implement `StorageAdapter` against it instead; pass an explicit instance (e.g. `import { createJsonFileAdapter } from 'keyforge-anvil-client'; createJsonFileAdapter({ filePath })`) to change the default file's location. |
| `getNow` | No | real clock (unix seconds) | Injectable clock seam, mainly useful for tests. |
| `fetchImpl` | No | global `fetch` | Injectable fetch seam, mainly useful for tests. |

The returned client exposes exactly four functions: `activate(licenseKey)`,
`getEntitlement()`, `refresh()`, `deactivate()` — matching the four
lifecycle operations above.

## `installationFingerprint`

A random UUID generated transparently the first time `activate()` is
called, and persisted under the `installationFingerprint` storage key (it
is not part of any status object `getEntitlement()`/`refresh()` return).
It identifies *this device*, not a particular activation:

- It is reused unchanged on any later `activate()` call from the same
  installation, which the server uses for idempotent reactivation.
- It **survives `deactivate()`** deliberately — `deactivate()` clears
  license-activation state (tokens, watermarks, the `revoked` flag) but
  intentionally keeps the fingerprint, since decommissioning a license
  isn't the same event as the device itself changing identity.

## Status and error vocabulary

### `getEntitlement()` statuses

Always network-free, never throws for any of these — an unexpected storage
error (e.g. corrupted state file) propagates instead of becoming a status.

| Status | Meaning |
|---|---|
| `not_activated` | No stored entitlement token — `activate()` hasn't run yet, or `deactivate()` cleared it. |
| `valid` | Signature, expiry, clock, and replay checks all pass. Returns `{ status, expiresAt, featureIds, features }` — `featureIds` is the token's array of licensed feature ids (keyforge-anvil's replacement for the old single `productId` claim); `features` is the open-ended capability map (currently `{ maxBranches }`). |
| `expired` | Token's signature is valid but it's past `expiresAt`. |
| `revoked` | The server reported a revocation on a past `refresh()` call — see [Revocation propagation](#revocation-propagation) below. |
| `tampered` | Signature invalid, payload malformed, `installationId` doesn't match this installation, or the token is a replay of an already-superseded one. |
| `unknown_key_version` | Token's `kid` isn't in the `publicKeys` this client was configured with — usually means local config is behind a server-side key rotation, not a fraudulent token. |
| `clock_rollback` | Local clock is behind the last recorded validation time. |

### `KeyforgeApiError` codes

Thrown by `activate()`/`refresh()`/`deactivate()` for genuinely unexpected
outcomes (never for `refresh()`'s expected "offline"/"rate limited" cases,
which resolve to `{ status: 'offline' }` instead of throwing).

**Client-side-detected** — these are synthetic codes this library produces
locally; they are never returned by the keyforge-anvil server, so you won't find
them in keyforge-anvil's own API docs:

| Code | Meaning |
|---|---|
| `MALFORMED_RESPONSE` | A 2xx response body was missing required fields or wasn't valid JSON. |
| `INSTALLATION_ID_MISMATCH` | A response's `installationToken`/entitlement token disagree on `installationId`. |
| `STALE_TOKEN_REPLAY` | A response's token is not newer than the last one this installation accepted — rejects replayed/captured old responses. |

**Server-reported** — `error.code` is passed through verbatim from
keyforge-anvil's own error vocabulary (this library never invents a parallel
vocabulary for these). A representative, non-exhaustive sample seen in this
codebase's tests: `LICENSE_INVALID`, `LICENSE_REVOKED`, `RATE_LIMITED`,
`INSTALLATION_TOKEN_INVALID`. keyforge-anvil's own docs are the authoritative,
complete list.

One related detail: the same underlying "token failed local verification"
condition surfaces two different ways depending on which function hits it —
`activate()` lets `TokenInvalidError`/`TokenExpiredError`/
`UnknownKeyVersionError` (from local crypto verification) propagate as
thrown errors, while `getEntitlement()` converts the identical condition
into a status string (`tampered`/`expired`/`unknown_key_version`) instead
of throwing. This follows from each function's own contract (`activate()`
is a one-time action that should throw; `getEntitlement()` reports state
and never throws for expected bad states), not an inconsistency.

## Revocation propagation

`getEntitlement()` runs entirely offline. Run purely offline, it cannot
know about a revocation that happened after the last successful
`refresh()` — the server can't tell a client something it hasn't
contacted. This is inherited by design from the keyforge-anvil server's own
architecture (revocation propagates only when a client reaches the
server, bounded by the entitlement token's expiry window); it is not a
defect in this client. Call `refresh()` periodically in the background to
bound how stale that window can get.

## Accepted limitations

Documented here briefly; see `PROGRESS.md` for the full rationale behind
each (found and evaluated during this project's per-phase security
reviews):

- **Clock+watermark co-tampering** — an attacker with local filesystem
  write access (the project's existing trust boundary) can roll the clock
  back and edit the local rollback watermark together, defeating both
  checks for an otherwise-genuine token.
- **Unbounded response body size** — no cap on `entitlementToken`/
  `installationToken` string sizes accepted from a response before
  verification.
- **Multi-write non-atomicity** — `activate()`/`refresh()` each issue
  several independent storage writes; a process killed mid-sequence can
  leave state requiring a retry (fails closed, not open).
- **`installationFingerprint`-seeding TOCTOU** — two concurrent, first-ever
  `activate()` calls on the same client could each generate a different
  fingerprint, with the second write silently winning.

## Development

- `npm test` / `npm run test:watch` — Vitest
- `npm run lint` / `npm run lint:fix` — ESLint
- `npm run format` / `npm run format:check` — Prettier

See `CLAUDE.md` for the full command list and `ARCHITECTURE.md`/
`PROGRESS.md` for design decisions and phase-by-phase history.

## License

MIT — see [LICENSE](./LICENSE).
