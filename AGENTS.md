# @j1nn0/pi-input-lock

Standalone Pi coding agent extension for `@earendil-works/pi-coding-agent` 0.84.2+, loaded via jiti without build.

## Communication

- Use Japanese only for user-facing responses.
- Use English for all other content, including internal reasoning, tool interactions, code, comments, documentation, commit messages, and agent-to-agent communication.

## Tech Stack

- Node >=24 · pnpm 11.22.0 (pinned via `packageManager`)
- TypeScript ^7.0.0 (`tsc --noEmit` only)
- vitest ^4.1.8
- No runtime dependencies; Pi packages are `peerDependencies`

## Structure

- `package.json` … publish metadata, Pi entry `["./index.ts"]`
- `index.ts` … re-export
- `src/index.ts` … input lock implementation (~940 lines)
- `test/` … state machine and routing tests
- `config.json` … optional local config (ignored, not tracked)

## State Machine

- `IDLE` … agent idle, input available
- `WATCH` … input blocked (locked surface), only the toggle and allowlisted exceptions pass, foreign UI passes through
- `OVERRIDE` … manual temporary unlock during a run, input available, toggle returns to `WATCH`
- `nextState(state,event)` is pure and unchanged: `IDLE --toggle→ IDLE`; `WATCH --toggle→ OVERRIDE --toggle→ WATCH`; `agent_start`: `IDLE/WATCH → WATCH`, `OVERRIDE → OVERRIDE`; `agent_settled → IDLE`. Duplicate `agent_start`/`settled` are idempotent.
- Default policy (`agent-settled`) is exactly `nextState`: inactive `IDLE` only; `agent_start` `IDLE → WATCH`; active `WATCH ↔ OVERRIDE` via toggle; settled `WATCH/OVERRIDE → IDLE`.
- Manual policy (`nextStateWithPolicy` + `resolveNextState`): initial `IDLE` (never forced to `WATCH` at startup); inactive `IDLE ↔ WATCH` via toggle; `agent_start` `IDLE/WATCH → WATCH`, `OVERRIDE → OVERRIDE`; active `WATCH ↔ OVERRIDE` via toggle; settled `WATCH → WATCH` (kept, no restore), `OVERRIDE → IDLE`.
- Agent activity invariant: `ctx.isIdle()` is the authoritative agent-activity source (`contextIsIdle(currentCtx) === false` means active); never infer activity from `lockState`.

## Activation

- Enabled only when `PI_INPUT_LOCK=1`. When unset, the extension is a no-op (no editor replacement, no listeners, no status, but pure functions remain importable). A parent Pi may have `HERDR_ENV` set and is still unaffected.

## Input Routing

- Dual channel: `tui.addInputListener` (TUI) + `ctx.ui.onTerminalInput` (terminal). `listenerInstalled` prevents duplicate registration, `offTerminalInput` cleans up.
- Router `createInputLockRouter(io, source)` consults `dialogOpen()` per key (via `isForeignFocus(tui.focusedComponent, {editor})`). A foreign focused UI always wins and owns its input: everything except `terminal+toggle` is `undefined` (pass-through), and `allowToolExpandInWatch` never hijacks foreign input. Otherwise in `WATCH`, only the configured toggle (owned by terminal; the `input`-channel toggle defers to avoid double dispatch) and the allowlisted exceptions pass; everything else is `{consume:true}` (block).
- `WATCH` allowlist (blocking by default): toggle handling; arrow/navigation pass-through (`isArrowSequence` returns `undefined` so sequences reach the focused component in either protocol); foreign focused UI; `app.tools.expand` only when `allowToolExpandInWatch=true`, matched action-based via `keybindings.matches(data,"app.tools.expand")` (follows user remaps, never a hardcoded raw Ctrl+O), press-only (`isKeyRelease`/`isKeyRepeat` ignored), terminal channel owns the single dispatch (`expandTools` is display-only: locked-editor action handler or `ui.setToolsExpanded` toggle).
- `isDuplicateNav` suppresses duplicate delivery for 20ms. `LockedEditor` renders `🔒 WATCH · <toggle> to interact` centered, `handleInput` is no-op and secondarily blocks Pi shortcuts. `BaseEditor` is retained only as an exported construction helper; the extension does not install it while `IDLE`.

## Editor Preservation

- `applyLockUI(true)` captures the exact `ui.getEditorComponent()` factory and `ui.getEditorText()` draft before borrowing the editor. The exact borrowed factory (including `undefined` for Pi's default) plus draft are retained while persistent `WATCH` survives settlement; `agent_settled` under `manual` performs no restore.
- Inactive manual unlock restores the exact factory + draft and disposes the listener; the capture clears only after success. Only a borrowed editor is ever restored (a foreign-focus unborrowed `WATCH` has no surface to restore). A restore failure falls back to the default editor and never declares `IDLE` with `LockedEditor` mounted.
- `CURSOR_MARKER` behavior unchanged: the lock owns the cursor anchor only while its own surface is active and no foreign UI holds focus (`setMarkerEnabled` gate re-derived on every routing pass; idle never owns the anchor).

## Config

- Lookup order in `readConfigJson`: (1) `<baseDir>/../config.json`, (2) `<baseDir>/config.json` (local/source-relative), (3) `~/.pi/agent/pi-input-lock.json` (canonical user config), (4) `~/.pi/agent/extensions/pi-input-lock/config.json` (legacy fallback). First existing file wins; settings are never merged across files; a malformed first-found file yields defaults via the outer try/catch with no fall-through.
- Defaults: `{ "toggleKey": "ctrl+alt+i", "allowToolExpandInWatch": false, "unlockPolicy": "agent-settled" }`. Partial configs merge with defaults; invalid values fall back to defaults.
- Process-lifetime cache (`resetInputLockConfigCache`; `resetToggleKeyCache` delegates); restart Pi after changing config.

## Fail-open

- With the default `agent-settled` policy the extension fails open: `handleAgentStart` calls `forceIdle()` unless `contextIsIdle(ctx) === false` confirms an active agent, and `refreshCtx` calls `forceIdle()` whenever `ctx.isIdle() === true`. Under `manual`, persistent `WATCH` after settlement is the intentional exception: `refreshCtx` keeps manual `WATCH` sticky on idle (re-ensures the listener + status) while manual `OVERRIDE` still force-idles. Exceptions, abort, error, `/new`, session switch, reload, duplicate events are idempotent via `applyTransition`, `handleSession` resets to `IDLE`, `setStatus` is try/catch.

## Lifecycle

- Manual stickiness crosses `agent_settled` only. Session/lifecycle boundaries (`session_start`, `session_before_switch`, `session_before_fork`, `session_shutdown`, plus reload paths through `handleSession`) always reset to `IDLE` with the existing cleanup semantics; stickiness never crosses them.

## Toggle

- Default `ctrl+alt+i` (Kitty `\x1b[105;7u` and legacy `\x1b\x09`), configurable via config `{toggleKey}` as any `KeyId` (`readConfigJson` scans the two local paths plus the canonical `~/.pi/agent/pi-input-lock.json` and the legacy fallback). `matchesToggleKey` uses `matchesKey` + 105;6u compatibility, `getToggleKeyId` normalizes.
- Commands `/input-lock` `/lock` switch state only in `WATCH`/`OVERRIDE`; when `lockState` is `IDLE` they notify `Input lock is only available while an agent is running.` and return. The keyboard toggle is not identical: under `manual` it can also turn `WATCH` on/off from inactive `IDLE`.

## Tests

- Verify via `pnpm check` / `pnpm test` / `pnpm pack:check`. When changing routing, keep `test/router.test.ts` foreign/owned cases. Construct `LockedEditor`/the exported `BaseEditor` helper with real theme/keybindings; the extension borrows no editor while `IDLE` and installs/disposes its input listener with `WATCH`.
- Main tests: 6 `nextState` transitions + duplicates, `isForeignFocus`, `toggleKey` matching, router WATCH block/OVERRIDE/IDLE, editor save/restore, agent lifecycle, disabled.

## Release

- Update `package.json` `CHANGELOG.md`, tag is `v0.1.0` form. Keep `pi-reader` derived MIT `Copyright (c) 2026 inobit`.
- Commit messages do not require `Co-authored-by: inobit pi-reader`.
