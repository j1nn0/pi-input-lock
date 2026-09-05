# Changelog

## [0.1.8] - 2026-09-05

- Add runtime enable/disable via `/input-lock enable` and `/input-lock disable` (with `/lock` aliases).
- Treat `PI_INPUT_LOCK=1` as startup auto-enable rather than a load requirement; `/input-lock status` reports whether runtime locking is enabled.

## [0.1.7] - 2026-09-04

- Add JSON Schema support for pi-input-lock configuration.
- Add `/input-lock status` for inspecting the current lock state and configuration. `/lock status` is also supported.

## [0.1.6] - 2026-09-04

- Add opt-in tool expansion during `WATCH` using the configured `app.tools.expand` action.
- Add the `manual` unlock policy, which keeps `WATCH` after agent settlement until an inactive toggle restores input.
- Document the new configuration options and release metadata.

## [0.1.5] - 2026-09-03

- Keep the hidden terminal cursor at a stable WATCH position while output is streaming.

## [0.1.4] - 2026-09-03

- Prevent terminal cursor flicker while WATCH mode is active.
- Show the active toggle shortcut directly in the WATCH prompt.

## [0.1.3] - 2026-09-03

- Toggle on key press only: ignore Kitty repeat (event type 2) and release (event type 3) so one physical toggle-key press toggles input-lock mode exactly once.

## [0.1.2] - 2026-09-03

- Preserve and restore the exact editor component around WATCH mode.
- Avoid taking ownership of the editor while idle.
- Dispose WATCH input listeners across unlock and session boundaries.
- Fail open to the default editor if custom editor restoration fails.

## [0.1.1] - 2026-09-03

- Remove obsolete project `.npmrc`.
- Translate `AGENTS.md` to English.
- Migrate npm releases to Trusted Publishing with OIDC.

## [0.1.0] - 2026-09-02

- chore: promote `@inobit/pi-reader` to standalone `@j1nn0/pi-input-lock` (single package, `pnpm-workspace.yaml`/`tsconfig.base.json` removed, `pi` entry at `./index.ts`, release tags `v*`). Based on `@inobit/pi-reader`; original MIT `Copyright (c) 2026 inobit` preserved.
- refactor: remove Vim reading-mode (j/k, gg/G, ctrl-u/d, ctrl-f/b, halfPage, GgSequence, CountBuffer, BracketSequence, row scanning, viewport anchoring, search, help overlay, tool expand, semantic navigation) and Vim terminology; introduce `IDLE`/`WATCH`/`OVERRIDE` with pure `nextState` (`IDLE --agent_start→ WATCH --toggle→ OVERRIDE --toggle→ WATCH --agent_settled→ IDLE`, `IDLE+toggle→IDLE`).
- feat: gate behind `PI_INPUT_LOCK=1` (Herdr child only, fail-open otherwise), wire `agent_start`/`agent_settled` lifecycle (covers retry/compaction/queued continuation), `setStatus("pi-input-lock", "🔒 WATCH …")`, `ctrl+alt+i` default toggle (configurable `toggleKey`), preserve `isForeignFocus` per-key foreign UI pass-through and `savedInput` editor restore, dual-channel `addInputListener` + `onTerminalInput` with dedup and arrow pass-through, session cleanup on all boundaries.

All notable changes to this project will be documented in this file.
