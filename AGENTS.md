# AGENTS.md

## Communication

- Use Japanese only for user-facing responses.
- Use English for all other content, including internal reasoning, tool interactions, code, comments, documentation, commit messages, and agent-to-agent communication.

## Project Rules

- Keep the extension disabled unless `PI_INPUT_LOCK=1`.
- Use `ctx.isIdle()` as the source of truth for agent activity; do not infer activity from the lock state.
- Preserve input ownership for foreign focused UI and avoid dispatching one terminal event twice.
- Restore the exact borrowed editor factory and draft when releasing the lock.
- Keep runtime dependencies empty and load TypeScript directly without a build step.
- Update both English and Japanese documentation when user-facing behavior changes.

## Validation

- Run `pnpm check` and `pnpm test` after code changes.
- Run `pnpm pack:check` when changing package contents or release metadata.
