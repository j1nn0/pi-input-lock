# @j1nn0/pi-input-lock

A small Pi extension that protects interactive input while an agent is running.
It is opt-in: the parent process is unchanged unless `PI_INPUT_LOCK=1` is set.

In `WATCH`, text input, submit, paste, and normal Pi shortcuts are blocked: typed
text is not inserted, submit does nothing, and shortcuts do not run. Arrow-key
navigation still reaches the focused component, and when a foreign interactive
UI (for example a permission dialog from Pi or another extension) has focus, it
keeps working and its input is not blocked. The original editor and draft text
are restored when the lock is released.

## Installation

```bash
pi install npm:@j1nn0/pi-input-lock
```

For local development:

```bash
PI_INPUT_LOCK=1 pi -ne -e . --tui-mode fullscreen
```

## Usage

Enable the extension explicitly:

```bash
export PI_INPUT_LOCK=1
```

The default toggle is `ctrl+alt+i`. Configure the extension in
`~/.pi/agent/pi-input-lock.json`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `toggleKey` | string | `ctrl+alt+i` | Shortcut used to toggle the lock. |
| `allowToolExpandInWatch` | boolean | `false` | When enabled, the Pi `app.tools.expand` keybinding (default Ctrl+O, follows user remaps) still expands/collapses tool output during `WATCH`. |
| `unlockPolicy` | `agent-settled` \| `manual` | `agent-settled` | Choose automatic or manual unlock after settlement. |

A recommended combined configuration:

```json
{
  "$schema": "https://raw.githubusercontent.com/j1nn0/pi-input-lock/main/pi-input-lock.schema.json",
  "toggleKey": "ctrl+alt+i",
  "allowToolExpandInWatch": true,
  "unlockPolicy": "manual"
}
```

JSON-aware editors can use pi-input-lock.schema.json for completion and validation.

The tool-expand exception follows the Pi `app.tools.expand` keybinding, so a
remapped key keeps working; it is not a hardcoded Ctrl+O.

Configuration is cached for the lifetime of the process; restart Pi after changing it.

`~/.pi/agent/extensions/pi-input-lock/config.json` is still accepted as a
legacy fallback, but `~/.pi/agent/pi-input-lock.json` is the canonical user
config and wins when both files exist (settings are never merged).

`WATCH`/`OVERRIDE`: `/input-lock` or `/lock` also toggles. To turn manual `WATCH`
on/off while the agent is stopped, use the configured toggle key.
`/input-lock status` reports the current lock state, agent activity, unlock policy, tool-expand setting, and toggle key without changing the lock state. `/lock status` is also supported.

States are lifecycle-aware:

- `IDLE`: input is available.
- `WATCH`: input is locked and the status bar shows `🔒 WATCH`.
- `OVERRIDE`: input is available after a manual toggle during an active run.

With the default `agent-settled` policy, agent start enters `WATCH` and agent
settlement returns from either active state to `IDLE`. With `manual`, settlement
keeps `WATCH` (from `OVERRIDE` it still returns to `IDLE`) until an inactive
toggle restores the editor and draft. Manual mode is not forced on at startup
(the extension still starts in `IDLE`), and session boundaries or reset events
always return to `IDLE` rather than remaining sticky. With the default
`agent-settled` policy, if the runtime cannot confirm that an agent is active,
it fails open to `IDLE`. Under `manual`, `WATCH` intentionally persists after
settlement until explicitly toggled off.

Known operational limitation (not a bug): with `unlockPolicy: manual`, `WATCH`
persists after the agent stops, so terminal-injected input (for example Herdr
sending the next prompt as key input) is still blocked. Workaround: 1. press the
toggle key to return `WATCH` → `IDLE`; 2. send the prompt from Herdr; 3.
`agent_start` re-enters `WATCH` automatically.

## Development

```bash
pnpm check
pnpm test
pnpm pack:check
PI_INPUT_LOCK=1 pi -ne -e . --tui-mode fullscreen
```

## License

MIT License.

This project is derived in part from `@inobit/pi-reader`,
Copyright (c) 2026 inobit, also licensed under the MIT License.
