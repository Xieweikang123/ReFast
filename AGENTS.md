# AGENTS.md

ReFast: a Windows quick-launcher (utools-style) built on Tauri 2 + React + TypeScript + Tailwind, with a Rust backend. Windows is the primary target; Everything search, global hotkeys, and the clipboard monitor are Windows-only.

## Commands

- `npm run dev:tauri` — dev mode. Vite runs on fixed port 1420 (`strictPort`).
- `npm run build` — typecheck (`tsc`) + Vite build. There is no separate lint/typecheck script; use this (or `npx tsc --noEmit`) to typecheck.
- `cargo check` (in `src-tauri/`) — required after every Rust change (see `.cursor/rules/checkrule.mdc`). `cargo check --tests` is also run in CI and compiles `#[cfg(test)]` code — private helpers used by tests must be `pub(crate)`. ~11 Rust tests exist under `#[cfg(test)]` (`cargo test` runs them).
- `npm test` — vitest (jsdom, ~15–60s; fully green as of 1.0.81). Run a single file with `npx vitest run src/utils/__tests__/dateUtils.test.ts` or add `-t "name"` for a single case. Full suite includes component tests (`.tsx` under `src/components/__tests__/`) which may log React `act()` warnings — pre-existing, not failures.
- `npm run build:tauri` — ⚠️ NOT a plain build: it first runs `scripts/sync-version.js patch` (bumps the patch version in `package.json`, `Cargo.toml`, `tauri.conf.json`), then builds. Use `tauri build` directly if you don't want a version bump.
- `npm run release` — legacy local upload of the built MSI to GitHub Releases via `gh`. Kept as emergency path; normal releases are automatic (see Release flow). Release tags have no `v` prefix.

## Architecture

- Single Vite SPA: `src/main.tsx` picks the React root app by WebviewWindow label (`launcher`, `recording-window`, `memo-window`, `translation-window`, etc.). Adding a window/app means registering it in BOTH `src-tauri/tauri.conf.json` (`app.windows`) and the `src/main.tsx` dispatch (plus capabilities if new permissions are needed).
- All Rust commands are listed in `src-tauri/src/main.rs` `invoke_handler!` (re-exported via `src-tauri/src/commands.rs`). A new command must be added there to be callable.
- Frontend calls Rust through `src/api/tauri.ts` (event tracking in `src/api/events.ts`).
- Persistence: SQLite via rusqlite (`src-tauri/src/db.rs`) and JSON settings in the app data dir (`src-tauri/src/settings.rs`).
- The plugin system is frontend-only. Builtin plugins live in `src/plugins/builtin/index.ts` (used both as fallback and by the registry). Adding a builtin plugin requires updating THREE places: the static import map in `src/plugins/loader.ts` (`importBuiltinPlugin`), the path map in `src/plugins/registry.ts` (`getBuiltinPluginPath`), and the window dispatch in `src/main.tsx`. External plugin dynamic loading is not fully implemented.

## Conventions / gotchas

- All comments, docs, and UI copy are in Chinese — match that style.
- Version is synced across `package.json` / `Cargo.toml` / `tauri.conf.json` only via `scripts/sync-version.js`. Never bump it in just one file.
- Do not remove the `custom-protocol` feature from `src-tauri/Cargo.toml` (comment in file marks it required).
- `tsconfig.json` enables `strict`, `noUnusedLocals`, `noUnusedParameters` — `npm run build` fails on unused vars/params.
- `src/test/setup.ts` mocks all `@tauri-apps/*` APIs; unit tests that touch Tauri must rely on those mocks (components currently excluded from coverage, which only covers utils).
- Branches: develop on `dev` (CI runs on every push); `master` = released code. **Merging dev → master triggers an automatic release**: the workflow reads the version from `package.json`, builds the MSI, and publishes a GitHub Release with that name (no `v` prefix). Idempotent — merging without a version bump skips publishing (release already exists). Before merging to master you MUST bump the version on dev via `scripts/sync-version.js patch|minor` and commit; commit messages follow conventional prefixes (`feat:`/`fix:`/`perf:`/`style:`/`chore:`) because `scripts/generate-notes.mjs` groups them into the release changelog.
- Result ranking rule (enforced in `compareSearchResults`, `src/utils/resultUtils.ts`): **any result that has been used (`use_count > 0` or `last_used > 0`) must always sort above Everything results**, regardless of match tier. Everything results have no usage data, so this rule fires before the tier comparison. Don't weaken or move it below tier/score without explicit user approval.
