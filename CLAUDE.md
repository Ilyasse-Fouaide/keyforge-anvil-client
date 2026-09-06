# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state

All four `ARCHITECTURE.md` §13 phases shipped, plus the `examples/` suite and npm
publishing. The repo was then **forked from `keyforge-client` to
`keyforge-anvil-client`** — the client for **keyforge-anvil**, a separate server
deployment whose entitlement token replaced the single `productId` claim with
`featureIds: string[]`. See `PROGRESS.md` (check it first — it supersedes this
section): its top "Fork" section is the authoritative record of what changed.

## Commands

- `npm test` / `npm run test:watch` — Vitest
- `npm test -- tests/unit/storage/json-file.test.js` — single file
- `npm test -- -t 'name of test'` — single test by name
- `npm run lint` / `npm run lint:fix` — ESLint
- `npm run format` / `npm run format:check` — Prettier (Markdown is intentionally excluded)

## What this project is

`keyforge-anvil-client` is a Node module (JavaScript, ESM, no TypeScript) that runs *inside a branch's local backend process* to talk to keyforge-anvil (the licensing server, a separate sibling repo). It is not a browser client — no UI, no framework dependency. It manages offline-safe license verification for one branch installation: local Ed25519 signature verification is the fast path, server contact (`activate`/`refresh`/`deactivate`) is one-time or background, and **the branch app must never block startup on a network call**.

Planned public API (ARCHITECTURE.md §4): `activate(licenseKey)`, `getEntitlement()` (network-free, returns a status object, never throws for expected bad states), `refresh()` (silently no-ops when offline), `deactivate()`.

## Relationship to keyforge-anvil (the server repo)

- Sibling repo, confirmed local path: `/c/Users/ifouaide/Documents/keyforge-anvil` (the `keyforge-anvil` deployment; the original `keyforge` server lives at `/c/Users/ifouaide/Documents/Keyforge` and remains this repo's `upstream`). keyforge-anvil is a separate, complete project — this client is deliberately its own repo, not a package inside it.
- The Phase 2 local-verification code (`src/crypto/verify.js`, `src/clock/rollback.js`) was originally a **port, not a reimplementation**, of the original keyforge server's `src/crypto/verify.js`, `tests/helpers/offlineClock.js` and `tests/offline-flow/clientVerification.test.js`. keyforge-anvil's own equivalents are unchanged except the token payload (`productId` → `featureIds: string[]`); re-check the real files line-by-line before touching this boundary rather than working from prose or memory.
- keyforge-anvil's `CLAUDE.md`/`ARCHITECTURE.md`/`docs/client-sdk-integration.md` document the server-side contract (`/activate`, `/validate`, `/refresh`, `/deactivate`, error vocabulary) this module is a client for. **Its `docs/client-sdk-integration.md` §"The entitlement token" is stale — it still shows `productId`; `src/crypto/entitlementToken.schema.js` + `ARCHITECTURE.md` §5 are authoritative.** Don't invent a parallel status/error vocabulary — map onto keyforge-anvil's existing one (ARCHITECTURE.md §9).

## Planned architecture (ARCHITECTURE.md §2, §5, §11)

```text
src/
├── activate.js / refresh.js / deactivate.js   # network operations
├── entitlement.js       # getEntitlement(): local verification composition
├── crypto/              # ported verify.js equivalent (jose, same lib as server)
├── clock/               # ported offlineClock.js equivalent
├── storage/
│   ├── adapter.js       # StorageAdapter contract + assertValidKey/assertValidValue — done (Phase 1)
│   └── json-file.js     # createJsonFileAdapter() — done (Phase 1)
└── index.js             # public API surface
```

Key decisions already made in the doc (don't relitigate without flagging it first):

- **Default storage is a plain JSON file, not SQLite** — deliberately corrected from an earlier draft. Two strings (entitlement token, installation token), no queries — SQLite would add native-binary install friction (`better-sqlite3`) for no benefit. The adapter interface stays generic/pluggable so an integrator with their own DB can swap it in.
- **Storage is a single flat file, `{ [key]: value }`, default path `<cwd>/.keyforge-client/state.json`, overridable via `filePath`** (Phase 1, closes §15's third open question — see `PROGRESS.md`'s Phase 1 section for the full rationale). `createJsonFileAdapter()` serializes concurrent calls in-process and writes atomically (temp file + rename); a matching in-memory fake lives at `tests/helpers/memoryAdapter.js` for later phases' tests to inject instead of touching disk.
- **Embedded public key(s) come from config passed at init, not hardcoded** — mirrors Keyforge's own public-key-manifest approach, so a server-side key rotation doesn't force a new release of this module.
- **Revocation propagation is bounded by design, not a bug**: `getEntitlement()` run purely offline cannot know about revocation since the last successful `refresh()`. This is inherited from Keyforge's own architecture and must be documented in this module's README, not "fixed" here.

Two things are still explicitly open design questions, not yet decided (§15): the exact public-key init shape and the exact error/status vocabulary mapping. Propose these explicitly before implementing rather than guessing.

## Workflow

- Same discipline as the Keyforge server repo: one Claude Code session per phase, `/clear` between them, `PROGRESS.md` updated at the end of each phase so a fresh session can resume without re-explanation.
- **Changes to `ARCHITECTURE.md` require explicit user approval before the file is edited** — propose the change and stop, don't self-approve and rewrite it.
- Phase 2 (local verification/crypto porting) should be treated with the same care as Keyforge's own crypto phases — plan mode, careful review of the ported boundary conditions (clock-rollback fail-closed behavior in particular).
