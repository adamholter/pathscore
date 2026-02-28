# PathScore Judge Evaluator

The Judge Evaluator flips the benchmark: instead of ranking **models** by SVG quality, it ranks **judge models** by how accurately they agree with human preference.

---

## How It Works

```
[Base Model A] ──┐
[Base Model B] ──┤──► SVG Pairs ──► [Judge 1]  ─┐
                                   [Judge 2]  ──┤──► Human Vote ──► Judge ELO
                                   [Judge N]  ──┘
```

1. **Phase 1 — Generate**: Base models produce SVGs for each prompt (standard generation)
2. **Phase 2 — Collect verdicts**: Every configured judge model evaluates every A/B pair independently
3. **Phase 3 — Human votes**: For each pair, a human picks which SVG is actually better (or both bad)
4. **ELO update**: Judges that agreed with the human beat judges that disagreed. Starting ELO 1000, K=32.

The result is a judge leaderboard: which model is most reliably aligned with human aesthetic judgment?

---

## Config Shape

```json
{
  "name": "Judge Evaluator Run",
  "mode": "judge_eval",
  "models": [
    { "id": "google/gemini-2.5-flash-lite" },
    { "id": "anthropic/claude-haiku-4.5" }
  ],
  "judges": [
    "google/gemini-2.5-flash",
    "openai/gpt-4o-mini",
    "anthropic/claude-haiku-4.5"
  ],
  "prompts": [
    { "id": "<uuid>", "text": "a red circle on white background" }
  ],
  "generation": { "temperature": 0.7 }
}
```

- **`models`**: base models that generate SVGs (cheap/fast recommended — quality doesn't matter here)
- **`judges`**: the models being evaluated (can overlap with `models`)
- **`prompts`**: same format as standard mode

---

## Human Voting UI

Access via: **Flow Builder → Judge Evaluator preset** or any `judge_eval` run's results page → "Vote on Pairs →" tab.

| Key | Action |
|-----|--------|
| `←` or `1` | SVG A is better |
| `→` or `2` | SVG B is better |
| `↓` or `3` | Both bad — neither is good |

After each vote, the UI reveals each judge's verdict with ✓/✗ indicators. Votes are submitted immediately; ELO updates after each.

---

## API Reference

### `GET /api/runs/:id/judge-eval/pending`
Returns pending tasks awaiting human votes.

```json
{
  "tasks": [{
    "id": "uuid",
    "gen_a_id": "uuid",
    "gen_b_id": "uuid",
    "prompt_text": "a red circle",
    "verdicts": "[{\"judge_model\":\"openai/gpt-4o-mini\",\"winner\":\"A\",\"score_a\":8,\"score_b\":6}]",
    "svg_a": "<svg ...>",
    "svg_b": "<svg ...>"
  }],
  "total": 10,
  "done": 4,
  "pending": 6
}
```

### `POST /api/runs/:id/judge-eval/vote`
Submit a human verdict.

```json
{ "task_id": "uuid", "winner": "A" }
```
`winner` must be `"A"`, `"B"`, or `"both_bad"`.

### `GET /api/runs/:id/judge-eval/results`
Returns judge ELO leaderboard.

```json
{
  "leaderboard": [{
    "judge": "openai/gpt-4o-mini",
    "elo": 1031,
    "agree": 7,
    "disagree": 3,
    "total": 10,
    "agree_rate": 70.0
  }],
  "total": 10,
  "done": 10,
  "pending": 0
}
```

---

## CLI Reference

Designed for LLM agent use. Output is token-minimal (TSV-style, no prose).

```bash
# Create and start a judge eval run (uses gemini-2.5-flash-lite + haiku-4.5 as generators,
# evaluates gemini-2.5-flash + gpt-4o-mini + haiku-4.5 as judges)
node cli.cjs judge-eval-create

# Check pending task count + preview next task's judge verdicts
node cli.cjs judge-eval-status <run-id>

# Vote on all pending tasks:
#   A        = first SVG is better
#   B        = second SVG is better
#   both_bad = neither
#   auto     = random (for pipeline testing, simulates full human session)
node cli.cjs judge-eval-vote <run-id> [A|B|both_bad|auto]

# Show judge ELO leaderboard
node cli.cjs judge-eval-results <run-id>
```

### Full pipeline test (no human required):
```bash
node cli.cjs judge-eval-create      # creates run, waits for completion
node cli.cjs judge-eval-vote <id> auto   # simulates human votes randomly
node cli.cjs judge-eval-results <id>     # shows judge ELO
```

Run IDs support 8-char prefix matching: `node cli.cjs judge-eval-status 9f0a2ec2`.

---

## ELO Algorithm

For each completed task:
1. Count which judges agreed with the human (correct set) and which disagreed (wrong set)
2. Run ELO between every correct-wrong pair: correct judge gets +ELO, wrong judge gets −ELO
3. `both_bad` votes: all judges who picked a winner are "wrong" — ties are also penalized

Formula: standard ELO with K=32, starting rating 1000.

```
E_correct = 1 / (1 + 10^((R_wrong - R_correct) / 400))
R_correct += K × (1 - E_correct)
R_wrong   += K × (0 - (1 - E_correct))
```

---

## Extension System

Judge Evaluator is implemented as a built-in **mode extension** (`id: builtin-judge-eval`). Enable it via the Extensions page or the Flow Builder's Judge Evaluator preset.

The extension hook receives the standard `helpers` object and uses:
- `helpers.generateOneSVG` — generate SVGs from base models
- `helpers.orFetch` — call judge models via OpenRouter
- `helpers.svgToPngDataUrl` — render SVGs to PNG for vision models
- `helpers.db` — store tasks in `judge_eval_tasks` table
- `helpers.emit` — broadcast SSE events for live UI updates

---

## LLM Agent Notes

This doc exists because PathScore has a CLI with feature parity for LLM agent use.

- All output is compact/machine-parseable: `key|value` or `key:value` format
- `auto` vote mode enables fully automated pipeline testing
- Short run ID prefix matching works on all commands
- `judge-eval-status` shows the raw judge verdicts before human votes, useful for sanity-checking judge behavior
- The `verdicts` column in `judge_eval_tasks` is a JSON array — parse it directly if querying the DB
