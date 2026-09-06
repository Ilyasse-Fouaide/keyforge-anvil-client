# Progress

Running status log. See `ARCHITECTURE.md` for design decisions and the phase plan (§13).

**Current state: all four `ARCHITECTURE.md` §13 phases done, plus the `examples/`
suite and npm publishing (see the sections below). The repo was then forked from
`keyforge-client` to `keyforge-anvil-client` — see the fork section immediately
below.**

---

## Fork → keyforge-anvil-client (`featureIds` token contract) ✅

Forked from `keyforge-client` (kept as the `upstream` remote; `origin` is now
`keyforge-anvil-client`) to be the client for **keyforge-anvil**, a separate
licensing-server deployment. keyforge-anvil collapsed the old Product + Plan model
into a flat `Feature` catalog, and its signed entitlement token replaced the
single `productId` claim with **`featureIds: string[]`** — a non-empty array of
Feature-id strings (`keyforge-anvil/src/crypto/entitlementToken.schema.js`,
`keyforge-anvil/ARCHITECTURE.md` §5). Everything else about the token is
unchanged: compact JWS, `alg: 'EdDSA'`, `kid = String(keyVersion)` header, SPKI
public keys, the three token error types, the clock-rollback check. The client's
network layer already matched keyforge-anvil's `/api/v1/licenses/*` endpoints
exactly (verified against its route/controller/schema source), so no
`activate.js`/`refresh.js`/`deactivate.js`/`network/` changes were needed.

### What changed

| Area | Change |
|---|---|
| `src/entitlement.js` | `getEntitlement()`'s `valid` status now also returns `featureIds` (`{ status, expiresAt, featureIds, features }`), relayed verbatim from the verified payload — exactly like `features`, with no `Array.isArray`/schema guard. |
| `src/crypto/verify.js` | Doc comment only: `featureIds` named alongside `features` as opaque passthrough. `assertValidPayloadShape` still checks `expiresAt` only. |
| `tests/` | `buildEntitlementPayload()` helper's `productId: 'prod_test'` → `featureIds: ['feature_menu', 'feature_orders']`; `valid`-shape assertions in `getEntitlement.test.js` / `index.test.js` gained `featureIds`; `verify.test.js` asserts `featureIds` is relayed and `productId` is absent; new "featureIds surfacing" block in `getEntitlement.test.js`. 118 → 120 tests. |
| Identity | `package.json` `name` → `keyforge-anvil-client`, `version` `0.1.0` → `0.2.0`, description / repo URLs / keywords; `README.md` title, install line, import specifiers, prose, and the `valid` status-table row; `CLAUDE.md` prose + sibling path. The exported factory stays **`createKeyforgeClient`** (not renamed — no API churn). The default storage dir stays `.keyforge-client/` (internal detail, not branding; renaming it would break existing installs). |
| `examples/` | Reworked for keyforge-anvil's admin API: `createProduct`/`createPlan` → `createFeature` (`POST /api/v1/admin/features`); `createSubscription` now sends `{ features: [id], gracePeriodDays, ... }` (no `productId`/`planId`; there is no `/plans` endpoint); list helpers page with `?limit=100` (the API max) and filter client-side; `sweepFixtures()` cascade is License → Subscription → Customer → Feature. Fixture prefix `KFC Example` → `KAC Example`. `fixtures.json` drops `productId`/`planId`, gains `featureId`/`featureIds`. Scenario 01 asserts `getEntitlement().featureIds` includes the licensed feature. Scenario 03 waits past the stored `highestIssuedAtSeen` second before `refresh()` (see below). All 6 scenario imports → `keyforge-anvil-client`. `examples/README.md` + `.env.example` rewritten for keyforge-anvil (server name, `npm run dev` / port 3000, Feature chain, `featureIds` in sample output). |

### Decisions

| Decision | Rationale |
|---|---|
| **Surface `featureIds` on `getEntitlement()` only**, not on `activate()`/`refresh()` return values | User-approved. `getEntitlement()` is the network-free path a branch app gates features on; the write paths' contracts (`{ expiresAt }` / `{ status, expiresAt }`) stay minimal. |
| **Relay `featureIds` verbatim, no validation** | The repo's settled "only validate what our own logic branches on" stance (Phase 2): signature verification proves the server produced the shape; `featureIds` is never branched on locally, only relayed — identical treatment to `features`. |
| **Keep `createKeyforgeClient` / `KeyforgeApiError` / `.keyforge-client/` names** | User-approved. The rebrand is the package identity; renaming the exported API or the on-disk storage dir would be breaking changes beyond the cosmetic scope, for no benefit. |
| **`examples/` list helpers filter client-side instead of using the admin API's `filters=` query param** | The advanced-filter field ids are coupled to each resource's `*_FILTER_FIELDS` config (which already broke this tooling once upstream). For a bounded dev database, pulling a `?limit=100` page and filtering the returned docs is more robust. |
| **Scenario 03 waits until wall-clock second > stored `highestIssuedAtSeen` before `refresh()`** | Entitlement-token `issuedAt` has 1-second resolution and `src/refresh.js`'s replay guard requires a *strictly* newer token. A real background refresh runs minutes/hours post-activation, but `run-all.js` can drive 01 → 03 within one second, making the server mint a same-`issuedAt` token that the guard correctly rejects as a replay. The wait reflects the real cadence; it is not a library change. |
| **`ARCHITECTURE.md`: title addendum only** | Repo rule requires explicit approval for `ARCHITECTURE.md` edits; the approved plan authorized exactly a short "Fork addendum" block under the title. The body predates the fork and is kept as the original planning record. |

### Not changed / non-issues found

- **No `productId` anywhere in `src/`** — the verification path only ever read
  `expiresAt` (+ `keyVersion` cross-check); the old `productId` claim was never
  consumed by this client, so the contract change is purely additive.
- **No intermediate "single product" representation** to convert to a list —
  token-payload fields are relayed verbatim; `featureIds` is a list only at the
  one point it lands in the status object.
- **keyforge-anvil's `docs/client-sdk-integration.md` is stale** — its "The
  entitlement token" section still shows `productId`. Not this repo's file;
  flagged in `CLAUDE.md`. `entitlementToken.schema.js` + `ARCHITECTURE.md` §5 are
  authoritative.

### Verified end-to-end

- `npm run lint` clean; `npm test` — **120 passing** across 10 files (was 118).
  `npm run format:check` flags CRLF on this Windows checkout (`core.autocrlf=true`,
  no `.gitattributes`) — pre-existing and unrelated; `prettier --end-of-line auto`
  on all `src/`/`tests/`/`examples/` JS is clean, and committed files are LF.
- **Live, against a real running keyforge-anvil server** (`npm run dev`, port
  3000, local MongoDB — not mocked): `npm run examples:run-all` — setup + all six
  scenarios + teardown **PASS**, run twice back-to-back to confirm
  re-runnability. Scenario 01's output shows a real EdDSA token carrying
  `"featureIds":["<id>"]` and the new assertion passing; scenario 03 shows the
  token rotating and watermarks advancing; 04 → `revoked`; 06 → `tampered`.
  (Repeated rapid re-runs can trip keyforge-anvil's in-memory admin-login rate
  limiter — 10/15 min/IP; restarting the server resets it. Same gotcha noted in
  keyforge-anvil's own `VERIFICATION.md`.)

### Carry-forward

- The narrow `refresh()`-within-the-same-second-as-`activate()` →
  `STALE_TOKEN_REPLAY` interaction (scenario 03's wait works around it) is a
  real, pre-existing property of `src/refresh.js`'s strictly-greater replay
  guard, not a regression. If a real integrator hits it, the fix is a design
  discussion about that guard (e.g. tolerate `issuedAt` equal to the watermark
  when the stored token differs), not a quiet loosening.

---

## Phase 0 — Scaffold ✅

`package.json`, ESLint/Prettier config, Vitest, and the empty `src/`/`tests/`
structure from §11. No storage, crypto, clock, or network logic yet —
that's Phases 1-4.

Verified end-to-end:

- `npm install` succeeds
- `npm test` — 1 passing (`tests/unit/placeholder.test.js`), no real
  functionality under test yet
- `npm run lint` — clean
- `npm run format:check` — clean

### Decisions made during Phase 0

| Decision | Rationale |
|---|---|
| **`storage/json-file.js`, not `storage/sqlite.js`** (§11 corrected) | §11's file tree still names `sqlite.js`, but §5 explicitly corrected the default adapter to a plain JSON file — SQLite would add native-binary (`better-sqlite3`) install friction with no benefit here. Stubbed with the corrected name so a later phase doesn't recreate the SQLite path §5 already ruled out. |
| **Tooling versions pinned to match Keyforge's own `package.json` exactly** (`eslint`, `prettier`, `vitest`, `jose`, etc.) | Consistency with the sibling server repo per ARCHITECTURE.md §13; for `jose` specifically this is also what §3 asks for directly — same library, same version, not just same algorithm. |
| **No `dev`/`start` npm scripts** | Unlike Keyforge, this is a library with no standalone runtime entrypoint — `src/index.js` is imported, not run. Scripts are limited to `test`/`test:watch`/`lint`/`lint:fix`/`format`/`format:check`. |
| **`main`/`exports` added to `package.json`**, pointing at `src/index.js` | Not called out in ARCHITECTURE.md, but necessary packaging metadata — without it the package isn't importable once Phase 4 fills `index.js` in. |
| **`package-lock.json` gitignored** | Mirrors Keyforge's own `.gitignore`/`.prettierignore` convention. |
| **`private: true`, `"license": "UNLICENSED"`** | Mirrored from Keyforge as a reasonable default for an unpublished internal package; revisit once distribution (private registry vs. git dependency) is decided. |
| **`no-console: 'warn'` kept in ESLint config, without Keyforge's pino-specific comment** | Keyforge's rule exists to protect its redacting logger's redact list; this module has no logger, so the rule is kept as general library hygiene only, with the now-inapplicable justification dropped. |
| **`src/*.js` stubs are comment-only, no exports** | Function signatures for `activate`/`getEntitlement`/`refresh`/`deactivate` depend on §15's still-open decisions (public-key init shape, error/status vocabulary mapping). Stubbing an export now would lock in a shape ahead of those decisions. |
| **`crypto/`, `clock/`, `tests/offline-flow/`, `tests/integration/` tracked via `.gitkeep`** | Git doesn't track empty directories; §11 doesn't name specific files inside `crypto/`/`clock/` (unlike `storage/`), so no filenames were invented for them this phase. |

### Carry-forward — things later phases must not forget

- §15's three open questions are still open: exact public-key init shape (§8), exact error/status vocabulary mapping (§9), exact JSON storage file layout/path convention (§5). Propose these explicitly before Phase 1/2 implementation, don't guess.
- `tests/unit/placeholder.test.js` is scaffolding only — replace/remove it once Phase 1 adds real storage-adapter tests.

---

## Phase 1 — Storage adapter interface + default JSON-file implementation ✅

`src/storage/adapter.js` (the `StorageAdapter` contract plus shared
`assertValidKey`/`assertValidValue` validation) and `src/storage/json-file.js`
(the default adapter). An in-memory fake (`tests/helpers/memoryAdapter.js`)
and a parameterized shared test suite (`tests/helpers/storageAdapterContract.js`)
prove both implementations honor the identical contract. Resolves §15's
third open question (exact JSON file layout/location convention). No crypto,
network, or `index.js` work — that's Phases 2-4.

Verified end-to-end:

- `npm test` — 34 passing across 2 files, includes both adapters running the
  identical shared contract suite plus adapter-specific cases
- `npm run lint` / `npm run format:check` — clean
- Manual sanity check (ad hoc script, deleted after): `set()` on a fresh
  adapter produces `.keyforge-client/state.json`-shaped file
  (`{ entitlementToken, installationToken }` flat map, pretty-printed) with
  no leftover `.tmp` file after a successful write

### Decisions made during Phase 1

| Decision | Rationale |
|---|---|
| **Single flat JSON file, `{ [key]: value }`, not one-file-per-key** | §5 already shows this shape (`{ entitlementToken, installationToken }`); the adapter itself stays key-agnostic rather than hardcoding those two names, since the interface is generic `get`/`set`/`delete`. The interface never asks for listing/iterating keys, so one file is simpler and sufficient. |
| **Default path `<cwd>/.keyforge-client/state.json`, overridable via `filePath`** | Mirrors Keyforge's own precedent for local file-based state (`scripts/generate-signing-keypair.js`'s cwd-relative `keys/` directory) rather than a home-directory or OS-specific app-data path — fits a long-lived branch backend process with its own meaningful working directory. |
| **Missing-key → `null`, never throws** | Not a fresh decision — already specified by §5's own interface signature (`get(key): Promise<string \| null>`). `delete()` on a missing key is a no-op, doesn't throw (not specified in §5, decided here — standard key-value semantics). |
| **Shared `assertValidKey`/`assertValidValue` in `adapter.js`** | One place enforcing the string-typed key/value contract so the JSON-file adapter and the in-memory fake can't drift apart. `get`/`set`/`delete` are declared `async` specifically so a validation throw becomes a rejected promise rather than a synchronous throw — caught a real bug during implementation where non-`async` methods let validation errors escape `expect(...).rejects`. |
| **In-process promise-queue serialization in `json-file.js`** | Without it, two concurrent `set()` calls on one adapter instance race a read-modify-write on the shared file and can lose an update — this is what the "concurrent writes" test (`does not lose an update when concurrent sets target different keys`) exercises. Scoped to calls within one process only; cross-process file locking isn't attempted, matching §2's one-process-owns-this-file design and §5's local-machine-is-the-trust-boundary reasoning. |
| **Atomic write: write to `<path>.tmp`, then `rename()` onto the real path** | A crash mid-write must never leave a half-written, unparseable `state.json` — that would look like corrupted licensing state on next boot. `node:fs` only, no new dependency. |
| **Corrupted JSON throws (`SyntaxError` propagates), never silently resets to `{}`** | Silently discarding unparseable existing data could turn a real problem into a quiet `not_activated` report later (Phase 2). Only `ENOENT` (no file yet) is treated as an empty store. |
| **`writeFile(..., { mode: 0o600 })`, `mkdir(..., { mode: 0o700, recursive: true })`** | Matches §5's "chmod 600-equivalent" ask and mirrors Keyforge's own `generate-signing-keypair.js` pattern for sensitive local files. Best-effort/no-op on this Windows dev machine; meaningful on the POSIX branch machines this actually ships to. |
| **In-memory fake lives in `tests/helpers/memoryAdapter.js`, not `src/`** | It's a test double (§10), not a production adapter, but ARCHITECTURE.md §10 frames it as reusable across later phases' test suites too — so it's placed under `tests/helpers/`, matching Keyforge's own `tests/helpers/*.js` convention, rather than buried in one test file. |
| **Shared parameterized contract suite (`tests/helpers/storageAdapterContract.js`)** | Runs the identical `describe`/`it` list against both adapters via a factory function, directly proving §10's swappability claim rather than just asserting it in prose. |

### Carry-forward — things later phases must not forget

- §15's other two open questions are still open: exact public-key init shape (§8), exact error/status vocabulary mapping (§9). Propose these explicitly before Phase 2/3 implementation, don't guess.
- Phase 2's `entitlement.js` will be the first real consumer of `createJsonFileAdapter`/`createMemoryAdapter` — inject the memory adapter in its unit tests rather than hitting disk, per §10.

---

## Phase 2 — Local verification: crypto + clock + getEntitlement() ✅

Ported `verifyEntitlementToken` (`src/crypto/verify.js`, `src/crypto/errors.js`)
and `assertNoClockRollback` (`src/clock/rollback.js`) line-by-line from
Keyforge server's `src/crypto/verify.js`/`errors.js` and
`tests/helpers/offlineClock.js`, via fresh subagent re-reads immediately
before each was written (not from an earlier paraphrase in the same
session). Composed them in `src/entitlement.js`'s `createEntitlementChecker()`,
translating the reference's exception-based contract into this module's own
status-object vocabulary. Resolves §15's other two open questions (public-key
init shape, error/status mapping). Full offline-flow scenario suite per §10,
plus a mandatory fresh-context adversarial security review that found two
confirmed, PoC-verified issues beyond the original plan — both handled before
considering this phase done (details below). No `activate`/`refresh`/
`deactivate` or `index.js` work — that's Phases 3-4.

Verified end-to-end:

- `npm test` — 81 passing across 6 files (was 34 after Phase 1)
- `npm run lint` / `npm run format:check` — clean
- Manual sanity check (ad hoc script, deleted after): a real Ed25519-signed
  token, driven through the real `createJsonFileAdapter` (real disk, temp
  dir) end-to-end through `createEntitlementChecker` — confirms `state.json`
  grows a `lastValidatedAt` key after a `valid` check
- Manual PoC re-verification (ad hoc script, deleted after): re-ran the
  security review's stale-token-replay scenario directly against `src/`
  (not just the new unit tests) and confirmed it now reports `tampered`
  instead of `valid`

### Decisions made during Phase 2

| Decision | Rationale |
|---|---|
| **Public-key init shape (closes §15/§8): inline PEM strings**, `{ publicKeys: { '1': '<PEM>' } }`, passed to `createEntitlementChecker()` and converted once via a new `src/crypto/keys.js` (`loadPublicKeys`, not a port) using `jose`'s `importSPKI` | This module never does file I/O for keys itself — the integrator supplies resolved PEM content however they already manage config. Matches Phase 1's "build the minimal shape now" precedent (plain JSON storage instead of SQLite) rather than porting the server's file-manifest loader and its relative-path-resolution questions. User-approved before implementation. |
| **Status vocabulary (closes §15/§9): +`unknown_key_version`**, mapped from `UnknownKeyVersionError` | Preserves the distinction the server's own client-SDK doc draws ("stale embedded key, needs a config update" vs. `tampered`'s "fraudulent token") — different operator response. Required and received an explicit, scoped `ARCHITECTURE.md` §4 edit (one line) before implementation, user-approved. All other collapsing (malformed structure, bad signature, schema violations, keyVersion/kid mismatch → `tampered`) is inherited unchanged from the server's own `TokenInvalidError` design. |
| **`getEntitlement()` ratchets `lastValidatedAt` forward** on every check where the clock check passes, regardless of the token's own verify outcome | Without this, rollback protection only guards against rolling back before the *last server refresh*, not the last local check. `getEntitlement()` stays network-free but is no longer read-only against storage — user-approved trade-off. |
| **New third storage key, `lastValidatedAt`, string-encoded unix seconds** | Follows the existing `StorageAdapter` contract (`get`/`set` are string-only, per `assertValidValue`). Missing (`null`) is passed through as `null`, never coerced via `Number(null)` (which is `0`, a finite number) — that coercion would silently defeat the fail-closed guard for "token exists but no watermark was ever written" (the state before Phase 3's `activate()` runs). This exact hazard has its own test. |
| **`getNow` injection seam**, defaulting to `() => Math.floor(Date.now()/1000)`, passed once at `createEntitlementChecker()` construction (not per-call) | Lets tests control "now" deterministically without faking global timers, consistent with `storage`/`publicKeys` also being construction-time dependencies. |
| **No `zod` dependency; `assertValidPayloadShape` in `verify.js` checks only `expiresAt`** instead of porting the server's full `entitlementTokenSchema` | Repo is deliberately dependency-light (`jose` only). Signature verification already proves authenticity; the server validated shape at signing time. Only `expiresAt` is checked because it's the only field this client's logic dereferences before a throw/no-throw decision — `now > payload.expiresAt` is `false` (not expired) for a missing/non-numeric `expiresAt`, the same silent-permissive-fallthrough shape as the clock-rollback bug this guards against by the same technique (`Number.isFinite`, not a bare comparison). `keyVersion` needs no separate check (`String(undefined)` can't match a real `kid`). `features` is passed through with zero shape validation — safe (never branched on locally) but a conscious scope boundary. |
| **`rollback.js`, not `offlineClock.js`** (the source file's name) | "Offline" described the *source's* context (a test helper for an offline-flow suite, with no in-repo caller — explicitly reference-only code there); here it's real production code, and the name should describe what it does. |
| **`src/crypto/keys.js` is new code, not a port** — Keyforge server's own `keys.js` (file-manifest loader) was read for shape reference only, never ported | Follows directly from the public-key init shape decision above: no file I/O, no manifest, no relative-path resolution to replicate. |
| **Storage errors always propagate, never map to a status** — confirmed by a dedicated test (corrupt `state.json` via the real `json-file` adapter → `getEntitlement()` rejects with `SyntaxError`, not any status object) | Matches Phase 1's own "corrupted JSON throws, never silently resets" philosophy; an unexpected error becoming a plausible-looking status (e.g. `tampered`) would be worse than a loud crash. |

### Security review — findings and disposition

A fresh-context adversarial subagent review (the packaged `security-review`
skill couldn't run here — its preamble hard-codes a `git log origin/HEAD...`
diff and this repo has no remote configured; adding one to work around it
would mean editing git config, which is off-limits, so the equivalent review
was run directly via a briefed subagent instead) found two confirmed,
PoC-verified issues and one low-severity code-quality note, none of which
were anticipated in the original plan:

1. **Fixed — stale/superseded token replay.** Neither `verify.js` nor
   `entitlement.js` compared a token's `issuedAt` against anything
   remembered locally, so restoring an old-but-still-validly-signed,
   still-unexpired `entitlementToken` file (e.g. one saved before a
   plan downgrade) verified cleanly as `valid` — no clock tampering
   required, just a second file. Fixed by adding a second watermark,
   `highestIssuedAtSeen` (same string-encoded-unix-seconds pattern as
   `lastValidatedAt`, same file), checked and ratcheted in
   `entitlement.js` right after a *successful* signature verification: a
   `payload.issuedAt` behind the watermark reports `tampered`; otherwise
   the watermark advances. Unlike `lastValidatedAt`, a missing
   `highestIssuedAtSeen` is **not** fail-closed — the first token an
   installation ever verifies has nothing prior to compare against, so
   absence just means "nothing seen yet," not "something is wrong."
   Verified both by new tests (`tests/offline-flow/getEntitlement.test.js`,
   "stale token replay protection" block) and by re-running the review's
   own PoC script directly against `src/` after the fix.
2. **Documented as an accepted limitation, not fixed — clock+watermark
   co-tampering.** An attacker with the filesystem write access the
   project's own threat model already grants (§5: "whoever has access to
   that machine already controls the ... system running on it") can roll
   the OS clock back *and* edit the plaintext `lastValidatedAt` down to
   match in the same stroke, defeating both the rollback check and the
   expiry check together for an otherwise-genuine, untampered token. There
   is no proportionate software fix within this module's stated
   constraints (dependency-light, no hardware anchor) — any local,
   secret-free value is exactly as editable as the one it's meant to
   protect. This is the same shape as §7's already-accepted
   revocation-propagation trade-off, just now concretely demonstrated
   rather than theoretical. The pre-fix code comment overclaimed what the
   watermark achieves ("closes the gap ... would otherwise look valid
   again," stated unconditionally); corrected to name the naive-rollback
   case it actually closes and the co-tampering case it does not.
   **Proposing, not self-approving:** an `ARCHITECTURE.md` addition near
   §5/§7 documenting this explicitly (mirroring §7's own treatment) — flagged
   to the user, not made, since only the one pre-approved §4 edit was
   authorized this phase.
3. **Fixed — bare `catch` around the clock check.** Tightened to match the
   verification `catch` block's pattern (`instanceof TypeError \|\|
   instanceof ClockRollbackDetectedError`, rethrow anything else). Not
   currently exploitable (`assertNoClockRollback` can only throw those two
   types today), but was a latent trap for a future change to that file.

Also explicitly tried and ruled out by the reviewer: algorithm-confusion,
prototype-pollution-style key names (the `Map` keying rules this out
structurally), non-string values written directly to the storage file
bypassing `assertValidValue`, and cross-process file races (already
out-of-scope per Phase 1's one-process-owns-this-file design).

### Carry-forward — things later phases must not forget

- **Phase 3's `activate()` must write an initial `lastValidatedAt` on
  success**, or every `getEntitlement()` call post-activation fails closed
  (`clock_rollback`) forever — there's no other way to bootstrap the
  watermark. `getEntitlement()` self-sustains it thereafter; `refresh()`
  doesn't strictly need to touch it.
- **Phase 3's `activate()` should also seed `highestIssuedAtSeen`** with the
  newly-activated token's own `issuedAt`, for the same reason and by the
  same pattern as `lastValidatedAt` above (harmless if omitted — the field
  fails open on first use — but seeding it is the more consistent,
  slightly-more-defensive choice).
- `revoked` still has no producing mechanism (e.g. a stored revocation flag
  `refresh()` could set after a 403) — Phase 3's to design; Phase 2
  deliberately built no hook for it.
- **`installationId` is never checked locally** — a validly-signed token for
  a *different* installation would currently verify `valid` here. Not
  closeable in Phase 2: there's nothing yet recording what this
  installation's own `installationId` should be. Phase 3's `activate()`
  should store the expected `installationId` so `entitlement.js` can
  compare against it.
- **Clock+watermark co-tampering** (security review finding #2 above) is a
  documented, accepted limitation, not a bug — don't attempt a local
  software fix without a genuinely new primitive (e.g. a monotonic-clock
  cross-check) being explicitly discussed and approved first; don't
  rediscover this and "fix" it with something that only adds false
  confidence.
- A narrow, bounded, non-attacker-exploitable race exists if `getEntitlement()`
  is ever called concurrently on the same checker instance (two reads of a
  stale watermark could write back out of order) — documented limitation,
  not fixed now; would need an atomic compare-and-swap primitive Phase 1's
  `StorageAdapter` contract doesn't have. Applies to both `lastValidatedAt`
  and the new `highestIssuedAtSeen`.
- An `ARCHITECTURE.md` addition documenting the clock+watermark limitation
  (see security review finding #2) is proposed but not yet made — needs
  explicit user approval before editing, per this repo's own rule.

---

## Phase 3 — Network operations: activate() / refresh() / deactivate() ✅

Built `createActivateClient`/`createRefreshClient`/`createDeactivateClient`
(`src/activate.js`, `src/refresh.js`, `src/deactivate.js`), each an
async-factory matching `entitlement.js`'s existing shape, plus
`src/network/errors.js` (`KeyforgeApiError`) and `src/network/request.js`
(shared POST-JSON + error/success body parsing). Closed all four of Phase
2's carry-forward items: `activate()` now writes the initial
`lastValidatedAt` watermark, seeds `highestIssuedAtSeen`, stores
`installationId`, and `entitlement.js` now checks a verified token's
`installationId` against it; `refresh()` now has a `revoked` storage flag
`getEntitlement()` checks. Server contract confirmed by reading the real
Keyforge repo's `docs/client-sdk-integration.md` plus its actual
route/controller/service source (not just the doc) — see the Confirmed
design decisions below for what that surfaced. A mandatory fresh-context
security review (same discipline as Phase 2) found one **critical**,
PoC-verified issue — a stale-token-replay attack that could clear a real
revocation — fixed before considering this phase done (details below).
`index.js`/README remain Phase 4.

Verified end-to-end:

- `npm test` — 114 passing across 9 files (was 81 after Phase 2)
- `npm run lint` / `npm run format:check` — clean
- Manual sanity script (ad hoc, deleted after): full
  `activate → getEntitlement(valid) → refresh → getEntitlement(valid,
  watermarks advanced) → replayed-response rejection → deactivate →
  getEntitlement(not_activated)` cycle against the real `createJsonFileAdapter`
  on disk (not the in-memory fake), confirming `installationFingerprint`
  survives `deactivate()`.

### Decisions made during Phase 3

| Decision | Rationale |
|---|---|
| **Revoked state: single boolean-ish flag**, storage key `'revoked'` = `'true'`, set by `refresh()` on any 403 entitlement-failure response, cleared on the next successful refresh | User-approved (of two proposed options). Lands inside the already-approved §4 status vocabulary — no ARCHITECTURE.md edit needed, matches Phase 2's own preference for collapsing into existing vocabulary over inventing new terms. |
| **`deactivate()` clears local license state entirely** (`entitlementToken`, `installationToken`, `installationId`, `lastValidatedAt`, `highestIssuedAtSeen`, `revoked`), **keeps `installationFingerprint`** | User-approved. Fingerprint is device identity, not license-activation state — it's meant to persist across a future re-activation per `docs/client-sdk-integration.md`'s own framing ("generated once at first run"). Subsequent `getEntitlement()` reports the existing `not_activated` status; no new vocabulary. |
| **`installationId` mismatch reports `'tampered'`**, not a new status | User-approved. Same category as a signature-tampered token from this module's perspective — no ARCHITECTURE.md edit needed, same pattern as Phase 2's stale-token-replay finding. |
| **`refresh()` treats 429 `RATE_LIMITED` identically to network-unreachable** — silent no-op, no throw, no state change | User-approved. Rate limiting is a "try again later" signal, not a real error; `refresh()`'s contract already requires never throwing for expected transient conditions. |
| **`installationId` is server-generated, `installationFingerprint` is client-generated** — confirmed by reading the real Keyforge repo, not assumed from ARCHITECTURE.md's prose | The task's own carry-forward note left this ambiguous ("from the activation response or generated locally... check docs/client-sdk-integration.md"). The doc and the actual route/controller/service source agree: `installationFingerprint` is a client-persisted UUID sent *to* `/activate`; `installationId` is the server's Activation-document id, returned *from* `/activate` and embedded in the signed token payload. `activate()` generates and persists the fingerprint via `node:crypto`'s `randomUUID()` (no new dependency), reusing it across future `activate()` calls per the server's idempotent-per-fingerprint design. |
| **No new HTTP client dependency** — global `fetch` (Node engine already `>=24`), injectable as `fetchImpl` for tests | Matches the project's dependency-light philosophy (`jose` is still the only runtime dependency). Test mocking uses a hand-rolled fake `fetchImpl` (`tests/helpers/fakeFetch.js`) rather than `nock`/`msw`. |
| **`activate()`/`refresh()` verify the received `entitlementToken` locally (same `crypto/verify.js` + `crypto/keys.js` machinery `getEntitlement()` uses) before persisting anything**, and prefer the *verified payload's* fields over the raw response body wherever both exist (`issuedAt`, `expiresAt`, `installationId`) | The core MITM/malicious-server defense: a compromised network path can return arbitrary JSON, but cannot forge a signature that verifies against the configured public keys. Nothing is written to storage until verification succeeds. |
| **`KeyforgeApiError(status, code, message)`**, one error class for all non-2xx and synthetic (`MALFORMED_RESPONSE`, `INSTALLATION_ID_MISMATCH`, `STALE_TOKEN_REPLAY`) failures, kept separate from `crypto/errors.js`'s `TokenVerificationError` hierarchy | Different failure domain (server rejected the request vs. a token failed local verification) — reuses the server's own `error.code` values verbatim rather than re-deriving a parallel vocabulary (ARCHITECTURE.md §9). |
| **`activate()`/`refresh()` reject a response whose `payload.issuedAt` is not strictly greater than the stored `highestIssuedAtSeen`** (when one exists), throwing `KeyforgeApiError('STALE_TOKEN_REPLAY', ...)` before any storage write | Added during the security review (see below) — not in the original plan. Closes a replay window neither `activate()` nor `refresh()` had: without it, a MITM/malicious server could replay any previously-captured, still-validly-signed, still-unexpired response to roll state backward, including clearing a `revoked` flag set by a real, later 403. |

### Security review — findings and disposition

A fresh-context adversarial subagent review, scoped specifically to the new
network-facing surface (`activate.js`/`refresh.js`/`deactivate.js`/`network/`
plus the `entitlement.js` changes), found:

1. **Fixed — CRITICAL: stale/replayed `/refresh` response could clear a real
   revocation.** `refresh()` verified the incoming `entitlementToken`'s
   signature and `installationId`, but never checked whether the token was
   *newer* than what was already accepted — only whether it should *advance*
   `highestIssuedAtSeen` (a decision, not a gate). A MITM or malicious server
   could capture a legitimate, validly-signed `200 /refresh` response, let a
   real subsequent `403` set `revoked = 'true'`, then replay the captured
   old response: it still verified, its `issuedAt` didn't trigger the
   (advance-only) watermark bump, and `refresh()` unconditionally cleared
   `revoked` and overwrote `entitlementToken` anyway — fully defeating
   revocation. PoC-confirmed by the reviewer (`getEntitlement()` went from
   `'revoked'` to `'valid'` purely via replay, no forged signature needed).
   Fixed by rejecting any response whose `payload.issuedAt` is not strictly
   greater than the stored `highestIssuedAtSeen` *before* any storage write
   — `throw KeyforgeApiError('STALE_TOKEN_REPLAY', ...)`. Strictly-greater
   (not `>=`) rejects exact replays too, since an honest `refresh()` always
   returns a token with a newer `issuedAt`. Verified by a new regression
   test (`tests/integration/refresh.test.js`, "rejects a replayed old
   /refresh response and does NOT clear a revoked flag set since (security
   review finding)") reproducing the exact attack sequence, plus a
   re-verification pass of the manual end-to-end script with an explicit
   replay-rejection step.
2. **Fixed — MEDIUM: `activate()` had no analogous freshness check.** Same
   root cause as #1: an already-active installation had no defense against a
   MITM/malicious server replaying an old, still-valid `/activate` response,
   which would silently roll `highestIssuedAtSeen` backward (defeating its
   purpose as `entitlement.js`'s replay-detection floor) and splice in a
   different `installationId`/`entitlementToken` wholesale. Fixed with the
   same strictly-greater-than-existing-watermark guard, applied before any
   write. Only meaningful when a prior watermark already exists — a
   genuinely fresh device, or one that just ran `deactivate()` (which clears
   this key), has nothing to compare against yet; that residual gap is the
   same "absence isn't fail-closed" reasoning already accepted for this
   field elsewhere (Phase 2), not newly introduced here.
3. **Fixed — LOW: malformed 2xx body threw a raw `SyntaxError` instead of
   `KeyforgeApiError`.** `activate()`/`refresh()` called `response.json()`
   directly on the success path with no try/catch, unlike the already-
   careful error-body parsing (`apiErrorFromResponse`). A malicious server
   returning `201`/`200` with an empty or non-JSON body produced an
   inconsistent error type. Fixed with a shared `parseSuccessBody()` helper
   in `network/request.js` that converts a JSON-parse failure into
   `KeyforgeApiError('MALFORMED_RESPONSE', ...)`, mirroring the existing
   error-path helper.
4. **Documented as an accepted limitation, not fixed — unbounded response
   body size.** Nothing caps the size of `entitlementToken`/`installationToken`
   strings accepted from a response before they're parsed/verified/persisted.
   No practical exploit exists without the server's private key (a forged
   giant token still fails signature verification), but the unbounded
   buffering of attacker-controlled data before rejection is a real memory/
   CPU amplification vector. No proportionate fix within this module's
   dependency-light, non-streaming design (a real cap would need
   content-length/streaming handling this library doesn't otherwise do) —
   flagged for a future phase if it becomes a concrete concern, not fixed
   speculatively now.
5. **Documented as an accepted limitation, not fixed — multi-write,
   non-transactional persistence sequences.** `activate()`/`refresh()` each
   issue several independent `storage.set`/`delete` calls; a process killed
   mid-sequence can leave a legitimately re-activated/refreshed installation
   reporting `'revoked'` or `'clock_rollback'` until the operation is
   retried. This fails *closed* (denies access), not open, so it's not an
   authorization bypass — same shape as Phase 1's already-accepted
   "in-process serialization only, no cross-call atomicity" limitation, now
   confirmed to extend to these multi-key write sequences too. The current
   write ordering (new token first, `revoked` cleared last) is deliberately
   the safer of the two possible orderings.
6. **Documented as an accepted limitation, not fixed — TOCTOU on
   `installationFingerprint` seeding under concurrent `activate()` calls on
   the same checker instance.** Two concurrent `activate()` invocations could
   each read a missing fingerprint as `null` and generate different UUIDs,
   with the second `set()` silently winning. Realistically out of scope:
   `activate()` is a human-initiated, one-time action, and this is the same
   single-process-owns-this-file trust model Phase 1 already established for
   compound (multi-call) operations specifically, as opposed to the
   single-call atomicity `json-file.js`'s internal queue does guarantee.

Also explicitly investigated and ruled out by the reviewer: prototype-
pollution/arbitrary-key paths from a server response into storage (both
files destructure only named fields, never spread unknown keys), algorithm
confusion (Phase 3 code doesn't touch `verify.js`'s existing `EdDSA` pin),
`deactivate()`'s response body (ignored entirely on success — a malicious
`/deactivate` response cannot influence what gets deleted, and
`installationFingerprint` is correctly excluded from the delete set),
`deactivate()` not catching fetch failures (confirmed deliberate per its own
"throws on failure" contract, not a bug), and `refresh()`'s status-code
dispatch (429/403/200/else) being exhaustive with no fallthrough that
mistreats an unrecognized status as success.

### Carry-forward — things Phase 4 must not forget

- `index.js` needs to construct all four (`createEntitlementChecker`,
  `createActivateClient`, `createRefreshClient`, `createDeactivateClient`)
  once with shared config (`storage`, `publicKeys`, `baseUrl`, optionally
  `getNow`/`fetchImpl`) and expose the bound functions matching
  ARCHITECTURE.md §4's literal public signatures.
- README needs §7's revocation-propagation caveat (already anticipated) plus
  a note on `installationFingerprint`'s purpose/persistence, since it's now
  real, user-facing-adjacent behavior (survives `deactivate()`, generated
  transparently on first `activate()` call).
- Findings #4–#6 above (unbounded response size, multi-write non-atomicity,
  fingerprint-seeding TOCTOU) are accepted limitations, not bugs to
  rediscover and "fix" later without a genuinely new design discussion —
  same treatment as Phase 2's clock+watermark co-tampering limitation.
- The Phase 2 carry-forward item about documenting clock+watermark
  co-tampering in ARCHITECTURE.md is already resolved — §7's "A related,
  structurally similar limitation" paragraph covers it. (Corrected here;
  an earlier version of this line incorrectly called it still pending.)
- `refresh()`'s `STALE_TOKEN_REPLAY`/`INSTALLATION_ID_MISMATCH`/
  `MALFORMED_RESPONSE` are synthetic `KeyforgeApiError` codes (not from
  Keyforge's own error vocabulary) — if `index.js` or the README ever
  document a full error-code table for integrators, these three need to be
  called out as client-side-detected, not server-reported.

---

## Phase 4 — Public API surface (`index.js`) + README ✅

Composed the four independent Phase 2-3 factories into one public entry
point, `src/index.js`'s `createKeyforgeClient(config)` — a single async
factory that constructs `createActivateClient`/`createEntitlementChecker`/
`createRefreshClient`/`createDeactivateClient` once via `Promise.all` over
one shared config object, and returns `{ activate, getEntitlement, refresh,
deactivate }` bound directly to each factory's own method. Added
`README.md` (didn't exist before this phase) covering quick-start usage,
configuration, `installationFingerprint`'s behavior, a full status/error
vocabulary table, the revocation-propagation caveat, and the accepted-
limitations list. Also corrected a stale carry-forward line from this same
Phase 3 section (see above): the clock+watermark co-tampering
ARCHITECTURE.md addition was already present in §7, not still pending as
previously stated here. This is the final phase per ARCHITECTURE.md §13.

Verified end-to-end:

- `npm test` — 118 passing across 10 files (was 114 after Phase 3)
- `npm run lint` / `npm run format:check` — clean
- Manual sanity script (ad hoc, deleted after): real `createJsonFileAdapter`
  on disk (temp dir), real crypto, mocked fetch, exercising
  `createKeyforgeClient`'s full `activate → getEntitlement(valid) → refresh
  → getEntitlement(valid, refreshed) → refresh(revoked) →
  replayed-refresh-rejection → deactivate → getEntitlement(not_activated)`
  cycle, confirming `installationFingerprint` survives `deactivate()`

### Decisions made during Phase 4

| Decision | Rationale |
|---|---|
| **`createKeyforgeClient(config)`, a single named async export, no default export** | Matches every other `src/` module's `create*` named-export convention. `package.json`'s `"exports": "./src/index.js"` is a bare string, so `index.js` is the only externally-reachable file regardless — kept its surface minimal and matching ARCHITECTURE.md §4 exactly (activate/getEntitlement/refresh/deactivate only, no re-exporting the four sub-factories separately). |
| **`storage` defaults to `createJsonFileAdapter()` when omitted; `publicKeys`/`baseUrl` have no default (required)** | User-approved (of two proposed options). Continues CLAUDE.md's already-settled "default storage is a plain JSON file" decision up to the composed-client level, so the README's quick-start example is genuinely zero-config beyond `publicKeys`/`baseUrl`. `getNow`/`fetchImpl` stay optional per-sub-factory defaults, passed through as literal `undefined` when omitted (each sub-factory's own default parameter fires on `undefined`, not just on the key being absent). |
| **No outer `= {}` guard on `createKeyforgeClient`'s parameter** | None of the four existing factories defend against zero-arg calls either — a raw destructuring `TypeError` on `createKeyforgeClient()` is consistent with existing behavior, not a regression. |
| **`.keyforge-client/` added to `.gitignore`** | The new default-storage path means a zero-config `createKeyforgeClient()` call (e.g. manual testing from repo root) now materializes that directory; wasn't previously ignored since nothing defaulted to creating it before this phase. |
| **New integration test `tests/integration/index.test.js`, using `createMemoryAdapter()`** (matching all three existing integration test files) plus one dedicated real-disk scenario for the new default-storage path (temp dir + `process.chdir()`, restored/cleaned in `finally`) | Confirms the one thing no per-function test covered: that all four bound functions returned by one `createKeyforgeClient()` call genuinely share the same storage instance through a real `activate → getEntitlement → refresh → getEntitlement → deactivate → getEntitlement` chain, plus a revoked-path variant and a required-field-validation check. |
| **README's error/status table explicitly separates `getEntitlement()`'s 7 status strings, `KeyforgeApiError`'s 3 synthetic (client-detected) codes, and its server-reported codes into three distinct sub-sections** | Directly closes the Phase 3 carry-forward note: integrators shouldn't go looking for `STALE_TOKEN_REPLAY`/`INSTALLATION_ID_MISMATCH`/`MALFORMED_RESPONSE` in Keyforge server's own docs and fail to find them. |
| **Accepted-limitations section in the README points to `PROGRESS.md` rather than re-explaining each item** | Matches the task's explicit instruction — brief pointer, not a re-derivation of Phase 2/3's security review findings. |

### Carry-forward — none; project complete

All four phases of ARCHITECTURE.md §13 are done. No open design questions
remain (§15's three were resolved across Phases 1-2). The accepted
limitations documented across Phases 2-4 (clock+watermark co-tampering,
revocation-propagation bound, unbounded response body size, multi-write
non-atomicity, `installationFingerprint`-seeding TOCTOU, the narrow
concurrent-`getEntitlement()` watermark race) are deliberate, documented
trade-offs — not bugs for a future session to rediscover and "fix" without
a genuinely new design discussion first.

---

## Addendum — `examples/` verification suite ✅

Not one of ARCHITECTURE.md §13's four phases (the module itself was already
complete after Phase 4) — additive tooling, same treatment the Keyforge
server repo gave its own `VERIFICATION.md`/`e2e/dashboard-smoke.js`. Adds
`examples/`: `setup-fixtures.js`/`teardown-fixtures.js` (create/sweep a real
Product→Plan→Customer→Subscription→License chain via Keyforge's admin API,
name-prefixed `KFC Example`), six numbered scenario scripts under
`examples/scenarios/` that walk one simulated branch installation through its
lifecycle against a real running Keyforge server (first activation, a
simulated reboot/offline check, background refresh, admin-triggered
revocation, deactivate/reactivate, and direct on-disk tampering), and
`run-all.js` to drive all of it plus print a pass/fail summary. Full setup and
troubleshooting docs in `examples/README.md`. No ARCHITECTURE.md changes — no
design decisions were revisited.

Verified end-to-end, against a real running Keyforge server + its existing
local MongoDB (not mocked, not assumed):

- `npm run examples:run-all` — all six scenarios plus setup/teardown pass,
  real Ed25519-signed tokens verified over a real network round trip.
- Ran the full suite twice back to back with no manual cleanup in between —
  confirms genuine re-runnability (see the permanent-residue finding below,
  which is why this needed a design change mid-implementation).
- Each scenario script run individually and standalone, in order.
- Ran a scenario out of order (03 before 01) against a clean `.state/` —
  confirmed the "run 01 first" guidance error, not a stack-trace crash.
- Triggered `REGISTRATION_CLOSED` directly (wrong password against the
  server's existing dev admin) — confirmed the actionable error message.
- `npm run lint` / `npm run format:check` — clean.

### Decisions made

| Decision | Rationale |
|---|---|
| **Shared sequential installation, not independent fixtures per scenario** — one `Product`/`Plan`/`Customer`/`Subscription`/`License` chain, one on-disk `examples/.state/state.json` used across all six scenarios in strict numeric order | User-approved (of two proposed options). Matches the task's own framing (`run-all.js` runs scenarios "in sequence", 06's destructive tampering is deliberately last, 05's "fingerprint survived" check only means something if it's surviving from an earlier point in a real lifecycle). Each script still independently runnable as a standalone `node` command — it self-checks its prerequisite via `requireExistingState()` and exits with a clear "run 0N first" message rather than a confusing crash if run out of order. |
| **Admin auth: login, falling back to one-time bootstrap registration, both via the same `KEYFORGE_ADMIN_EMAIL`/`PASSWORD` env vars** (`examples/lib/adminApiClient.js`'s `createAdminSession`) | Matches the task's explicit ask ("bootstrap or existing admin creds via env vars"), no interactive prompt. Keyforge server itself has no admin-credentials env var or non-HTTP bootstrap other than its own DB-direct `create-admin`/`delete-admin` scripts (confirmed by reading its source) — `POST /admin/auth/register` only succeeds once, while zero admins exist, so this suite tries login first and only attempts registration on a `401`, surfacing a clear actionable error on `403 REGISTRATION_CLOSED` (credentials don't match an admin that already exists) rather than a cryptic one. |
| **Name-prefix (`KFC Example`) + sweep-before-and-after convention**, `sweepFixtures()` shared by both `setup-fixtures.js` and `teardown-fixtures.js` | Directly reuses the pattern found in Keyforge server's own `VERIFICATION.md`/`e2e/dashboard-smoke.js` (its `PW`-prefix convention), per the task's explicit instruction to give this "the same treatment." Discovers fixtures by name rather than trusting one run's own ID bookkeeping, so it's self-healing against a crashed prior run and safe to point at a real shared dev database. |
| **`sweepFixtures()` best-effort deactivates the recorded installation (via the real `deactivate()` public API) before attempting to delete its License** | Worth doing regardless of the finding below: it's the correct real-world cleanup action and frees the License's `activationsUsed` slot count server-side, even though (see below) the row itself can't actually be deleted afterward. Scenario 06 deliberately corrupts only the stored `entitlementToken` (not `installationToken`), specifically so this step still works afterward. |
| **Confirmed against the real server (an assumption in the original plan turned out wrong): an activated License's whole fixture chain can never be deleted through the admin API, ever** — `deactivateInstallation()` only sets the Activation's `status` to `'deactivated'`, never deletes the row, and the delete-guard's dependents query (`{ licenseId: id }`, `src/services/license.service.js`) counts Activations regardless of status; there is no admin route to delete an Activation directly. Fixed by giving every run's `Product`/`Plan`/`Customer`/`Subscription` a unique `Date.now()`-suffixed name/slug (`kfc-example-<runId>`), not a fixed one | The original plan assumed `deactivate()` before delete would free the guard — reasonable from reading the docs, wrong in practice, caught only by actually running the suite against a live server rather than stopping at lint-clean. A fixed slug would have collided with the previous run's now-permanently-undeletable `Product` on every second run, breaking the "re-runnable from scratch" claim entirely. `teardown-fixtures.js` now reports each undeletable row plainly (`Not deleted (HAS_DEPENDENTS): ...`) plus one summary note, rather than an alarming warning — same category of accepted residue as Keyforge server's own `ApiKey`/`AuditLog` rows (also delete-less), per its `VERIFICATION.md`. Documented in `examples/README.md`'s own "confirmed, permanent limitation" section. |
| **Scenario 05 un-revokes the license via the admin API before its final `activate()` call** — not in the task's literal scenario description | Necessary correction found while cross-referencing Keyforge's own error table: `LICENSE_REVOKED` (403) blocks `activate()`, not just `refresh()`/`validate()`. Since scenario 04 leaves the fixture license revoked and nothing else in the flow restores it, omitting this step would make 05's final "activate() again" fail. Documented explicitly in `examples/README.md` as a deliberate addition, not a silent deviation. |
| **`examples/lib/scenario.js`'s `check()`/`run()` — plain `console.log`/exit-code checks, no test framework** | Mirrors Keyforge server's own `e2e/dashboard-smoke.js` convention exactly (plain Node + `PASS`/`FAIL` lines): Vitest is reserved for the real `tests/` suite; this is a runnable-against-a-live-server script, a different kind of artifact. |
| **`run-all.js` spawns each step as a real child process** (`node:child_process`'s `spawnSync`), not an in-process function call | Makes 02-reboot-offline-check.js's "new process" claim genuinely true even when driven by the orchestrator, and keeps one script's crash from taking down the whole run. Stops the scenario loop at the first failure (later scenarios assume earlier ones succeeded) but always still runs `teardown-fixtures.js` afterward, since the prefix-based sweep cleans up partial state safely regardless of where a run stopped. |
| **No `dotenv` dependency** — `examples/lib/env.js` uses Node's built-in `process.loadEnvFile()` | Consistent with the module's existing dependency-light stance (`jose` is still the only runtime dependency); Node's engines field is already `>=24`, well past `process.loadEnvFile`'s availability. |
| **`examples/.env` and `examples/.state/` gitignored**; `eslint.config.js` gets a `no-console: 'off'` override scoped to `examples/**/*.js` | The former are runtime artifacts (real credentials, a real on-disk license state file), not checked-in fixtures. The latter reflects that this is CLI tooling whose entire purpose is console output, unlike `src/`'s general library-hygiene reasoning for keeping that rule on (Phase 0's own decision, PROGRESS.md above) — scoped narrowly rather than changed repo-wide. |

### Carry-forward — none new

This addendum doesn't change any of the four phases' carry-forward items
above. `examples/` has no bearing on the library's own runtime behavior — it
only consumes the public API (`createKeyforgeClient` from the package's own
entry point) plus, for harness purposes only, the non-exported
`createJsonFileAdapter` via a relative import (not part of the package's
public `exports` surface, since only `src/index.js` is reachable from
outside).

---

## Post-release fixes — found via external consumer ✅

Two documentation/packaging bugs, both found by a MenuForge session (a real
consumer of this package) reading the actual source because the README's own
guidance didn't work as written — same category as Keyforge server's own
License-deletion finding (caught by actually using the thing, not by
lint/tests alone).

| Issue | Fix | Rationale |
|---|---|---|
| README Quick Start's `const entitlement = client.getEntitlement();` was missing `await` | Added `await` | `getEntitlement` is `async` (`src/entitlement.js`, bound through in `src/index.js`) — the unawaited call assigned a `Promise` to `entitlement`, making `entitlement.status` read as `undefined` in the exact snippet meant to be copy-pasted. |
| README's Configuration table told integrators to pass `createJsonFileAdapter({ filePath })` to customize the storage location, but the function was never reachable from outside the package — `package.json`'s `"exports": "./src/index.js"` (bare string) blocks all subpath imports, and `createJsonFileAdapter` wasn't re-exported from `index.js` either | Re-exported `createJsonFileAdapter` from `src/index.js`; updated the README's example to `import { createKeyforgeClient, createJsonFileAdapter } from 'keyforge-client'`. `package.json`'s single-entry-point `exports` field is unchanged. | Two fixes were possible: open a subpath export (`./storage/json-file.js`) in `package.json`, or re-export the function from `index.js`. User-approved the latter — it fixes the actual defect (the function is now reachable) without making `src/storage/json-file.js`'s file location part of the public contract, and it's additive to Phase 4's deliberate "index.js is the only externally-reachable file" decision rather than a reversal of it (that decision was about not re-exporting the four *internal lifecycle* factories — `createJsonFileAdapter` isn't one of those four, and the README already documented calling it directly). |

Verified end-to-end: `npm run lint` / `npm test` (118 passing, unchanged)
still clean after the `index.js` export addition.

---

## npm publishing ✅

Not one of ARCHITECTURE.md §13's four phases — additive packaging work to
make the already-complete library installable via `npm install
keyforge-client` instead of only a git dependency or local path (per the
"Relationship to Keyforge" section, this repo was always meant to be a
standalone published module, not a subpackage of the server repo).

### package.json changes

| Field | Before | After | Rationale |
|---|---|---|---|
| `private` | `true` | *(removed)* | Blocks `npm publish` outright; had to go for a real publish. |
| `license` | `"UNLICENSED"` | `"MIT"` | User-selected (explicitly confirmed, not invented) — public permissive license appropriate for a public npm package. |
| `author` | *(absent)* | `"ilyasse-fouaide <ilyasse.fouaide@gmail.com>"` | User-confirmed exact string, matching `git config user.email`. |
| `repository` / `homepage` / `bugs` | *(absent)* | derived from the existing `origin` git remote (`github.com/Ilyasse-Fouaide/keyforge-client`) | User confirmed use of the existing remote rather than inventing a URL. |
| `keywords` | *(absent)* | `license`, `licensing`, `entitlement`, `offline`, `ed25519`, `keyforge` | Registry discoverability; drawn from the existing description/README, not new claims. |
| `files` | *(absent)* | `["src"]` | Without this, `npm pack`/`publish` fell back to `.gitignore` as its exclusion list, which would have shipped `tests/`, `examples/` (full live-server scenario scripts), `ARCHITECTURE.md`, `PROGRESS.md`, `CLAUDE.md`, and all dev tooling config. `package.json`/`README.md`/`LICENSE`/the main entry file are always included by npm regardless of `files`. |

`version` (`0.1.0`), `engines` (`node >=24`), `main`/`exports`/`type`, and
all `scripts`/`dependencies`/`devDependencies` were left unchanged —
publishing didn't require touching the API or runtime behavior.

### New file: `LICENSE`

Standard MIT text, copyright `ilyasse-fouaide`, 2026.

### README changes

Replaced the "This package is `private: true`... install via git
dependency or local path" note with an `## Installation` section
(`npm install keyforge-client`), and added a one-line `## License` section
pointing at MIT/the `LICENSE` file. No changes to the Quick Start code
sample — it already imported from the bare `'keyforge-client'` specifier.

### Verification performed

1. `npm run format:check` / `npm run lint` / `npm test` — all clean, 118/118
   tests passing, unchanged from pre-publish state.
2. `npm pack --dry-run`, then a real `npm pack` — tarball contains exactly
   16 files (`LICENSE`, `README.md`, `package.json`, all of `src/**`),
   15.8 kB packed / 48.6 kB unpacked. Nothing from `tests/`, `examples/`,
   or the markdown planning docs leaked in.
3. **Local-tarball consumer test**: built the real `.tgz`, installed it
   (`npm install <path-to-tgz>`) into a throwaway project outside this
   repo, and ran a script importing `createKeyforgeClient` and
   `createJsonFileAdapter` from `'keyforge-client'`. Confirmed: import
   resolves, both are functions, the returned client exposes exactly the
   four public methods (`activate`/`deactivate`/`getEntitlement`/
   `refresh`), `getEntitlement()` on a fresh unactivated install returns
   `{ status: 'not_activated' }` with no network call, and the `jose`
   runtime dependency installs correctly alongside the package (2 packages
   added total) — confirming the dependency graph resolves from a bare
   tarball install, not just from this repo's dev `node_modules`.

### Publish

Published as `keyforge-client@0.1.0`, public, unscoped (name was
confirmed unclaimed on the registry beforehand via a direct registry
lookup). The account has 2FA set to `auth-and-writes`; the initial
`npm publish` attempts failed (`E403`, then transient `E401`/`E404` during
retries) because the interactive OTP challenge npm expects for
publish-with-2FA couldn't complete automatically — the user resolved this
by authenticating and publishing directly themselves from their own
terminal.

Post-publish verification:

- `npm view keyforge-client version` → `0.1.0`.
- `npm view keyforge-client --json` — confirms all package.json metadata
  (license, author, repository, homepage, bugs, keywords, exports, deps)
  landed on the registry as intended.
- **Registry consumer test**: fresh throwaway project, `npm install
  keyforge-client@0.1.0` (real registry install, not a local tarball),
  same smoke script as above — passed identically.

### Carry-forward — none

Nothing about the library's runtime behavior or public API changed in this
phase; this was packaging/metadata/distribution only.
