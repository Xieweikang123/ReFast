# AGENTS.md

ReFast: a Windows quick-launcher (utools-style) built on Tauri 2 + React + TypeScript + Tailwind, with a Rust backend. Windows is the primary target; Everything search, global hotkeys, and the clipboard monitor are Windows-only.

## Commands

- `npm run dev:tauri` — dev mode. Vite runs on fixed port 1420 (`strictPort`).
- `npm run build` — typecheck (`tsc`) + Vite build. There is no separate lint/typecheck script; use this (or `npx tsc --noEmit`) to typecheck.
- `cargo check` (in `src-tauri/`) — required after every Rust change (see `.cursor/rules/checkrule.mdc`). No Rust test suite exists.
- `npm test` — vitest (jsdom, ~60s). Currently has pre-existing failures: a deterministic one in `src/utils/__tests__/launcherUtils.test.ts` (`isMathExpression` scientific-notation case) plus occasional wait-for timeouts in component tests when the whole suite runs together. Don't "fix" these unless asked; they predate your work.
- `npm run build:tauri` — ⚠️ NOT a plain build: it first runs `scripts/sync-version.js patch` (bumps the patch version in `package.json`, `Cargo.toml`, `tauri.conf.json`), then builds. Use `tauri build` directly if you don't want a version bump.
- `npm run release` — uploads the built MSI to GitHub Releases via `gh`. Details in `docs/RELEASE.md`. Release tags have no `v` prefix.

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
- Working branch is `dev` (`master` also exists).
