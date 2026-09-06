# keyforge-client — Architecture & Planning Document

> **Fork addendum (keyforge-anvil-client).** *This repo is now the client for **keyforge-anvil**, a separate server deployment whose entitlement token replaced the single `productId` claim with `featureIds: string[]` (`keyforge-anvil/ARCHITECTURE.md` §5). The JWS format, EdDSA signing, key format, token error types and clock-rollback check are all unchanged. `getEntitlement()` now also returns `featureIds`. See `PROGRESS.md`'s "Fork" section for what changed. Everything below this line predates the fork and still says "keyforge-client" / "Keyforge"; it is kept as the original planning record, not rewritten.*

Status: **Proposal — pending your approval before implementation begins**
Companion project to Keyforge (the licensing server). This doc assumes familiarity with Keyforge's own `ARCHITECTURE.md` and doesn't re-derive decisions already made there — it references them directly.

---

## 1. Understanding of the project

Keyforge's server side is done: `/activate`, `/validate`, `/refresh`, `/deactivate` exist, signed offline entitlement tokens work, and `docs/client-sdk-integration.md` documents the contract. What doesn't exist yet is the actual client — the code a branch installation of the menu platform runs to talk to that contract.

**Important terminology clarification, since "client" is overloaded across the two projects:** in Keyforge's own docs, "the client" means a branch installation as a whole. In this doc, `keyforge-client` is a **Node module that runs inside a branch's local backend process** (not literally a browser). A branch's menu-platform frontend never talks to Keyforge directly — it talks to its own local backend, which uses `keyforge-client` to manage licensing state and exposes whatever subset of that state the frontend needs (e.g. "is this branch entitled" as a simple flag). This keeps the Ed25519 verification, the embedded public key, and the SQLite storage entirely server-side within the branch's own machine — nothing licensing-related needs to run in a browser.

The one hard constraint carried over from Keyforge's own design: **the branch app must never block its own startup on a network call.** Local verification is the fast path; server contact is a background nicety, not a dependency.

---

## 2. Recommended architecture

A small, framework-agnostic, dependency-light Node module — not a UI library, not tied to Express or any particular menu-platform stack, since it needs to work regardless of what framework the menu platform itself ends up using.

```
Branch's local backend process
  └── keyforge-client (this module)
        ├── activate()       → network, one-time
        ├── getEntitlement() → local only, every check
        ├── refresh()        → network, background/periodic
        └── deactivate()     → network, decommission
              │
              ├── crypto (verify signature, port of Keyforge's verify.js)
              ├── clock (rollback detection, port of offlineClock.js)
              └── storage adapter (pluggable, default SQLite)
```

No microservices, no separate process — this is a library the branch's existing local backend imports and calls, same "modular monolith" instinct Keyforge itself used.

---

## 3. Language, runtime, dependencies

- **JavaScript, not TypeScript** — matches Keyforge's own convention.
- **Node**, ESM modules — target whatever Node LTS Keyforge's own `package.json` engines field specifies, for consistency.
- **`jose`** for signature verification — same library `src/crypto/verify.js` uses. Same library, not just same algorithm, so behavior stays identical to the server's own verification, not just "compatible in theory."
- **No framework dependency** (no Express, no React) — this module has no HTTP server of its own and no UI. It's called, not run.

---

## 4. Core API surface

Four functions, matching the two lifecycle diagrams already sketched:

```js
await activate(licenseKey)
// POST /activate against configured Keyforge base URL.
// Stores { entitlementToken, installationToken } via the storage adapter.
// Throws on failure (invalid key, network error, already-activated-elsewhere) —
// this is a one-time, human-initiated action; a thrown error is appropriate,
// unlike getEntitlement()'s status-object design below.

getEntitlement()
// NETWORK-FREE. Loads the stored entitlement token, verifies it locally.
// Returns a status object, never a bare boolean:
//   { status: 'valid', expiresAt, features }
//   { status: 'expired' }
//   { status: 'revoked' }       // only detectable once refresh() has run since
//                                 revocation — see §7's propagation note
//   { status: 'tampered' }
//   { status: 'unknown_key_version' } // token's kid isn't in this module's configured publicKeys
//   { status: 'clock_rollback' }
//   { status: 'not_activated' } // no stored token at all
// This module REPORTS state. It does not decide what the calling app does
// with a bad status (degraded mode vs. hard stop is the menu platform's call,
// not this module's — matches Keyforge server's own service/controller
// separation: services report, controllers decide HTTP-level behavior).

await refresh()
// POST /refresh using the stored installation token — ONLY if a real
// connectivity check succeeds first (attempt the call, catch failure; never
// trust a navigator.onLine-equivalent flag, which lies more often than it
// helps). Silently no-ops if unreachable — this must never throw for "offline,"
// only for genuine unexpected errors. Updates stored tokens on success.

await deactivate()
// POST /deactivate using the stored installation token. For decommissioning
// a branch. Throws on failure — this is a deliberate, human-initiated action.
```

---

## 5. The storage adapter

Pluggable interface, default implementation backed by SQLite:

```js
interface StorageAdapter {
  get(key): Promise<string | null>
  set(key, value): Promise<void>
  delete(key): Promise<void>
}
```

Two keys needed: the entitlement token and the installation token. Simple enough that a generic `get`/`set`/`delete` is sufficient — no need for a richer schema at this module's scope.

**Default: a plain JSON file on disk** (e.g. `{ entitlementToken, installationToken }`, written via Node's built-in `fs`), not SQLite. Corrected from an earlier draft of this doc, which recommended SQLite by loose analogy to the menu platform's own local database — that reasoning doesn't actually transfer here. The real storage need is two strings, no queries, no relations, no schema; that's a "read/write a small file" problem, not a database problem. SQLite would also introduce a real practical cost this module can't justify: `better-sqlite3` requires a native binary compiled per platform, which is genuine install friction for a library meant to run unmodified across whatever OS/architecture each branch machine happens to be — a plain JSON file has no such constraint. Configurable file path/directory at initialization; file permissions restricted to the owning user where the platform supports it (`chmod 600`-equivalent), though see the security note below on why this isn't a hard requirement.

**Why pluggable at all, given the default is now intentionally minimal:** if a branch's local backend already manages its own SQLite (or other) database for menu/order data, an integrator may still reasonably prefer to store these two values there instead of a separate file. The adapter interface (`get`/`set`/`delete`) costs nothing to keep generic and means that choice doesn't require forking this module — but the *default* implementation should match the *actual* data shape, not the heavier option "just in case."

**Security note on plaintext storage:** the entitlement token is a signed JWS — tampering is caught by signature verification regardless of read access, so storing it in plaintext doesn't weaken anything. The installation token is a bearer credential (Keyforge §7) and more sensitive, but the branch machine's local filesystem is already the trust boundary for this whole system — whoever has access to that machine already controls the restaurant's POS/menu system running on it. This is the same trust model as a CLI tool's locally-stored API key, not a new problem this module needs to solve.

---

## 6. Local verification — porting, not re-deriving

`getEntitlement()`'s core logic already exists, tested, in Keyforge's own repo:
- Signature/expiry verification: `src/crypto/verify.js`'s `verifyEntitlementToken`
- Clock-rollback detection: `tests/helpers/offlineClock.js`'s `assertNoClockRollback`, **including its fail-closed-on-malformed-input behavior** — the bug Phase 7's security review caught (silently trusting a token when `lastValidatedAt` was `undefined`/`NaN`) must not be reintroduced here by porting carelessly.
- The composition order: `tests/offline-flow/clientVerification.test.js`'s `verifyStoredToken` helper — clock check *before* signature verification, exactly as Phase 7 tested and documented.

This is a **port, not a copy-paste**: `verify.js` currently imports `jose` and Keyforge's own error classes (`TokenInvalidError` etc. from `src/crypto/errors.js`) — this module needs its own equivalent error/status vocabulary (§4's status object), so the porting work is translating Keyforge's exception-based internal design into this module's status-object external design, while preserving every boundary condition the original test suite already proved correct. Claude Code should read the three source files listed above line-by-line before writing this module's version, not summarize-and-reimplement from memory of what they do.

---

## 7. Revocation propagation — a real limitation to document, not solve here

Per Keyforge's own §5: revocation propagates only when a client successfully reaches the server (i.e., when `refresh()` succeeds), bounded by the entitlement token's expiry window. This module inherits that limitation by construction — `getEntitlement()` alone, run purely offline, cannot know about a revocation that happened after the last successful `refresh()`. This is not a bug to fix in this module; it's the documented trade-off Keyforge's architecture already made deliberately. Worth stating explicitly in this module's own README so an integrator doesn't mistake "revoked but still reporting valid offline" for a defect.

**A related, structurally similar limitation**: the clock-rollback watermark (`lastValidatedAt`, §6) lives in the same plaintext, unauthenticated local file as the entitlement token itself. It protects against a *naive* clock rollback but not against an attacker who edits both together — no local, secret-free value can defend against a party who can already edit the file storing it. Same local-filesystem-is-the-trust-boundary limitation §5 already accepts for the installation token, now applying to the rollback watermark too.

---

## 8. The embedded public key

`getEntitlement()`'s signature verification needs Keyforge's Ed25519 public key(s) — plural, since Keyforge's own `keyVersion` design (Phase 3) anticipates rotation.

Recommendation: **configuration, not hardcoding.** A config object or file passed at module initialization — `{ "1": "<public key PEM>" }`, matching Keyforge's own public-key-manifest shape (Phase 3's `LICENSE_SIGNING_PUBLIC_KEYS_PATH`) — rather than a key baked into this module's source. Reasoning: the public key isn't secret, but hardcoding it would mean every branch installation ships a copy of whatever key was current when `keyforge-client` was built, and a key rotation on the server side would require a new release of this module rather than a config change on each branch. Mirrors Keyforge server's own reasoning for why its public-key manifest is a file path, not a checked-in constant.

Propose the exact initialization shape (a config object passed to a constructor/init function, vs. environment variables, vs. a config file path) before implementing — this is a real API design decision, not just plumbing.

---

## 9. Error handling and status vocabulary

- `activate()`/`deactivate()`/`refresh()`'s network-error handling should distinguish, at minimum: unreachable/offline (expected, not exceptional for `refresh()`), and a real rejection from the server (invalid key, already activated, revoked — genuinely exceptional, should surface clearly).
- `getEntitlement()`'s status strings should map cleanly onto the error types Keyforge's own `src/crypto/errors.js` and the endpoint-level error codes already define (per `docs/client-sdk-integration.md`) — don't invent a parallel vocabulary that means the same thing with different names. Propose the exact mapping before implementing.

---

## 10. Testing strategy

- **Port, don't skip, Phase 7's offline-flow scenarios** against this module's own `getEntitlement()`: valid, tampered, expired, unknown keyVersion, clock rollback, malformed token. This is the highest-value test suite in this module too, for the same reason it was in Keyforge itself.
- **Integration tests for `activate`/`refresh`/`deactivate`** against a mocked Keyforge API (not a real running server — this module's tests shouldn't require Keyforge itself to be running).
- **Storage adapter tests**: the default SQLite adapter, plus a test double proving the interface itself is genuinely swappable (a fake in-memory adapter satisfying the same interface, used in the other test suites so they don't depend on SQLite specifically).
- Same test runner Keyforge uses (Vitest) for consistency, unless there's a concrete reason not to.

---

## 11. Project structure

```
keyforge-client/
├── src/
│   ├── activate.js
│   ├── entitlement.js       # getEntitlement() + local verification composition
│   ├── refresh.js
│   ├── deactivate.js
│   ├── crypto/               # ported verify.js equivalent
│   ├── clock/                 # ported offlineClock.js equivalent
│   ├── storage/
│   │   ├── adapter.js         # interface/contract
│   │   └── sqlite.js          # default implementation
│   └── index.js               # public API surface
├── tests/
│   ├── unit/
│   ├── offline-flow/          # ported Phase 7 scenarios
│   └── integration/            # mocked-API activate/refresh/deactivate
├── CLAUDE.md
├── ARCHITECTURE.md             # this document
├── PROGRESS.md                  # running phase-by-phase status log, see §14
└── README.md                   # includes §7's revocation-propagation caveat
```

---

## 12. Relationship to the Keyforge repo

This is a **separate repo**, not a package inside Keyforge's own repo. Reasoning: Keyforge itself is finished and stable (all 8 phases closed per its own `ARCHITECTURE.md`) — bundling active development of a new module into that repo risks disturbing a project that's done. A separate repo also matches the real deployment shape: Keyforge runs once, centrally; `keyforge-client` runs N times, once per branch, on machines that never run Keyforge itself.

Claude Code sessions working on this repo should be given a **local path to the Keyforge repo** (or copies of the three specific files named in §6) as reference material — not asked to reconstruct the verification logic from this document's prose description alone. Prose here documents *decisions*; the actual porting work needs the real source.

---

## 13. Phased implementation plan

| Phase | Scope | Notes |
|---|---|---|
| 0 | Scaffold: repo, `package.json`, ESLint/Prettier matching Keyforge's config where sensible, `CLAUDE.md`, this doc committed | Plan mode |
| 1 | Storage adapter interface + default JSON-file implementation, with the swappable-adapter test double | Confirms §5's file-based default is sufficient; a SQLite (or other) adapter is only built later, if a real integrator need shows up |
| 2 | Local verification: ported `crypto/`+`clock/` modules, `getEntitlement()`, full offline-flow test suite (§10) | Plan mode mandatory, same seriousness as Keyforge's own Phase 3/7 — this is the crypto-adjacent phase |
| 3 | Network operations: `activate()`, `refresh()`, `deactivate()`, mocked-API integration tests | |
| 4 | Public API surface (`index.js`), README (including §7's revocation-propagation documentation), final end-to-end pass | |

Four phases, not eight — this module is a fraction of Keyforge's scope. Phase 2 is the one to treat with real care; the rest is comparatively routine integration work, similar to how Keyforge's own CRUD phases (1, 2, 5, 6) moved faster than its crypto phases (3, 4, 7).

---

## 14. Managing context and sessions across phases

Same discipline Keyforge's own `ARCHITECTURE.md` §19 established — carried forward here explicitly rather than assumed, since it's easy to skip on a "smaller" project and regret it by Phase 3.

- **`PROGRESS.md`** is the running status log, updated at the end of every phase: what shipped, what was verified, decisions made and their rationale, and a carry-forward list of anything a later phase must not forget. This is what lets a fresh session resume without you re-explaining state. Follow Keyforge's own `PROGRESS.md` as the literal template for structure and level of detail — it's proven across 8 phases.
- **`CLAUDE.md`** points at both `ARCHITECTURE.md` and `PROGRESS.md`, same as Keyforge's own — plus one line specific to this repo: the local path to the Keyforge server repo (confirmed: `/c/Users/ifouaide/Documents/Keyforge`), since Phase 2 in particular needs to read real files from it, not reconstruct their behavior from memory or from this doc's prose.
- **One session per phase**, named for resumability, `/clear` between them — identical to Keyforge's own workflow.
- **Subagents for the porting work in Phase 2 specifically**: reading and translating `verify.js`/`offlineClock.js`/`clientVerification.test.js` from the Keyforge repo is exactly the kind of read-heavy, reference-checking task worth delegating to a subagent so the main session's context stays focused on writing this module's own code, not on holding the entirety of three foreign source files in context throughout.
- **The same `CLAUDE.md` approval rule applies**: changes to this `ARCHITECTURE.md` require explicit approval before the file is edited, not a self-approved rewrite — carried over identically from Keyforge's own workflow rule.

---

## 15. Open questions carried into implementation (not decided here)

- Exact public-key initialization shape (§8)
- Exact error/status vocabulary mapping (§9)
- Exact JSON file layout/location convention for the default storage adapter (§5) — a sensible default path, not a design question, but worth Claude Code proposing explicitly rather than guessing

Everything else in this document is a firm recommendation, not a question — flag disagreement now rather than mid-phase if any of §2–§7 or §11–§13 don't match your intent.

---

**Waiting on your approval (or pushback) before starting Phase 0.**