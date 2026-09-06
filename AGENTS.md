# AGENTS.md

## Communication

- Use Japanese only for user-facing communication.
- Use English for all non-user-facing communication and generated artifacts unless the repository, task, or existing content requires another language.
- Use English for agent-to-agent communication, delegation prompts, plans, findings, summaries, intermediate reports, tool-related annotations, code comments, documentation, and commit messages.
- Keep non-user-facing communication concise and information-dense. Do not restate context already available to the receiving agent.
- Preserve the language of existing content when editing it unless the task explicitly requires changing it.

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
