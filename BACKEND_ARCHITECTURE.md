# PathScore Backend Architecture

## Entry point

- `server.cjs` is now bootstrap-only.
- Main app factory: `src/server/index.cjs`.

## Modules

- `src/server/config`: environment and runtime flags.
- `src/server/db`: SQLite initialization, schema, migrations, startup recovery.
- `src/server/repositories`: data access layer for each table group.
- `src/server/services`: OpenRouter client, SVG utilities, stats, SSE bus.
- `src/server/orchestrator`: shared generation/judging pipeline and run engine.
- `src/server/modes`: mode-specific behavior (`standard`, `feedback_iteration`, `image_to_svg`, `svg_editing`, `human_eval`).
- `src/server/extensions`: built-ins and runtime compile/validation/hardening.
- `src/server/api`: route registration and HTTP handlers.

## Runtime flags

- `PATHSCORE_EXTENSION_RUNTIME=strict|legacy` (default `legacy`).
- `PATHSCORE_INVARIANT_CHECKS=0|1` (default `0`).

## Testing

- API parity smoke tests in `test/api-parity.test.cjs`.
- Run with `npm test`.
