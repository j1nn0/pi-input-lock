# Changelog

## [0.1.1] - 2026-09-03

- Remove obsolete project `.npmrc`.
- Translate `AGENTS.md` to English.
- Migrate npm releases to Trusted Publishing with OIDC.

## [0.1.0] - 2026-09-02

- chore: promote `@inobit/pi-reader` to standalone `@j1nn0/pi-input-lock` (single package, `pnpm-workspace.yaml`/`tsconfig.base.json` removed, `pi` entry at `./index.ts`, release tags `v*`). Based on `@inobit/pi-reader`; original MIT `Copyright (c) 2026 inobit` preserved.
- refactor: remove Vim reading-mode (j/k, gg/G, ctrl-u/d, ctrl-f/b, halfPage, GgSequence, CountBuffer, BracketSequence, row scanning, viewport anchoring, search, help overlay, tool expand, semantic navigation) and Vim terminology; introduce `IDLE`/`WATCH`/`OVERRIDE` with pure `nextState` (`IDLE --agent_start→ WATCH --toggle→ OVERRIDE --toggle→ WATCH --agent_settled→ IDLE`, `IDLE+toggle→IDLE`).
- feat: gate behind `PI_INPUT_LOCK=1` (Herdr child only, fail-open otherwise), wire `agent_start`/`agent_settled` lifecycle (covers retry/compaction/queued continuation), `setStatus("pi-input-lock", "🔒 WATCH …")`, `ctrl+alt+i` default toggle (configurable `toggleKey`), preserve `isForeignFocus` per-key foreign UI pass-through and `savedInput` editor restore, dual-channel `addInputListener` + `onTerminalInput` with dedup and arrow pass-through, session cleanup on all boundaries.

All notable changes to this project will be documented in this file.
