# @j1nn0/pi-input-lock

A small Pi extension that protects the interactive input surface with a manual
watch lock. While locked, text, submit keys, and actions are consumed; native
CSI and SSU arrow sequences continue to reach the focused component. The
original editor and draft text are restored when the lock is released.

## Installation

```bash
pi install npm:@j1nn0/pi-input-lock
```

For local development:

```bash
pi -ne -e . --tui-mode fullscreen
```

## Usage

- Toggle the lock with `alt+o`.
- Use `/input-lock` or `/lock` for the same action.
- Configure the shortcut in `.pi/agent/extensions/pi-input-lock/config.json`:

```json
{ "toggleKey": "alt+o" }
```

The lock has three lifecycle-ready states: `IDLE`, `WATCH`, and `OVERRIDE`.
Only `WATCH` blocks input. Agent lifecycle integration is intentionally left to
a later phase.

## Development

```bash
pnpm check
pnpm test
pnpm pack:check
```

## License

MIT
