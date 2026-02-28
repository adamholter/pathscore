# PathScore

**SVG generation benchmark for open-source LLMs via OpenRouter.**

Compare any set of models on SVG generation quality using pairwise VLM judging and ELO rankings.

https://github.com/adamholter/pathscore/raw/main/demo.mp4

## How it works

1. **Configure** — Select models, define prompts, pick a judge model
2. **Run** — All SVG generations fire in parallel; pairwise VLM judging starts as generations complete
3. **Results** — ELO leaderboard + win-rate heatmap + full comparison browser

## Setup

```bash
npm install
cp .env.example .env  # Add your OpenRouter API key
node server.cjs
```

Open http://localhost:7642

## Environment variables

```
OPENROUTER_API_KEY=sk-or-...
PORT=7642
```

## Export formats

- **JSON** — Full dataset (configs, SVGs, comparisons, metadata) for reproducibility
- **HTML** — Standalone report page with leaderboard and heatmap
- **PDF** — Browser print-to-PDF

## Pairing strategy

For N models and M prompts:
- Generates N × M SVGs in parallel
- Creates all N × (N-1) / 2 unique pairs per prompt
- Randomly assigns A/B positions to eliminate position bias
- Runs each pair through the VLM judge (configurable 1-5 runs per pair)

## ELO system

Standard ELO starting at 1000 with K=32. Win=1, Tie=0.5, Loss=0.

## Tech stack

- **Backend**: Node.js + Express + SQLite (better-sqlite3)
- **Models**: OpenRouter API (400+ models available)
- **Frontend**: Vanilla JS SPA, PathScore brand identity
- **Streaming**: Server-Sent Events for live run updates

## License

MIT
