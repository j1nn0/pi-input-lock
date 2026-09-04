# @j1nn0/pi-input-lock

A small Pi extension that protects interactive input while an agent is running.
It is opt-in: the parent process is unchanged unless `PI_INPUT_LOCK=1` is set.

In `WATCH`, text, submit keys, paste, and Pi application shortcuts are consumed.
CSI and SSU arrow sequences continue to reach the focused component, and foreign
interactive UIs such as permission dialogs always receive their input. The
original editor and draft text are restored when the lock is released.

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
| `allowToolExpandInWatch` | boolean | `false` | Allow the configured `app.tools.expand` action during `WATCH`. |
| `unlockPolicy` | `agent-settled` \| `manual` | `agent-settled` | Choose automatic or manual unlock after settlement. |

A recommended combined configuration:

```json
{
  "toggleKey": "ctrl+alt+i",
  "allowToolExpandInWatch": true,
  "unlockPolicy": "manual"
}
```

Configuration is cached for the lifetime of the process; restart Pi after changing it.

`~/.pi/agent/extensions/pi-input-lock/config.json` is still accepted as a
legacy fallback, but `~/.pi/agent/pi-input-lock.json` is the canonical user
config and wins when both files exist (settings are never merged).

The same action is available as `/input-lock` or `/lock`.

States are lifecycle-aware:

- `IDLE`: input is available.
- `WATCH`: input is locked and the status bar shows `🔒 WATCH`.
- `OVERRIDE`: input is available after a manual toggle during an active run.

With the default `agent-settled` policy, agent start enters `WATCH` and agent
settlement returns from either active state to `IDLE`. With `manual`, settlement
keeps `WATCH` until an inactive toggle restores the editor and draft. Manual mode
is not forced on at startup (the extension still starts in `IDLE`), and session
boundaries or reset events always return to `IDLE` rather than remaining sticky.
If the runtime cannot confirm that an agent is active, it fails open to `IDLE`.

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
