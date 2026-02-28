# PathScore Flow Builder

The Flow Builder is a visual node-based editor for designing benchmark pipelines. Instead of filling out a multi-step wizard, you drag and connect nodes to express exactly how a benchmark should run — which models compete, what prompts they receive, how judging works, and what mode governs the run.

---

## Getting Started

Click **Flow** in the top navigation bar. The canvas loads with the **Quick Showdown** preset — two models, three prompts, one judge, and a runner connected to a results node. Click **Launch** (or the Launch button inside the Results node) to start the benchmark immediately.

---

## The Pipeline

Every benchmark follows this shape:

```
[Model]  ──┐
[Model]  ──┤
  ...    ──┤──► [Runner] ──► [Results]
[Prompt] ──┤
[Judge]  ──┘
```

All Model nodes feed into the Runner's first input. The Prompt Pack feeds the second input. The Judge feeds the third. The Runner outputs to Results.

---

## Node Types

### Model
Represents a single LLM competing in the benchmark.

| Field | Description |
|-------|-------------|
| Model ID | OpenRouter model string, e.g. `anthropic/claude-sonnet-4-5` |
| Reasoning Effort | `none`, `low`, or `high` — passed as the reasoning parameter for models that support it |

Add as many Model nodes as you want. They all wire into the Runner's first input port (Drawflow allows multiple connections to one input).

---

### Prompt Pack
A collection of text prompts that every model is asked to generate SVGs for.

| Field | Description |
|-------|-------------|
| Prompts | Editable list — click `+ Add prompt` to add rows, `×` to delete |

Prompts are stored as a JSON array internally. Each prompt gets a UUID when the flow is launched.

---

### Judge
Controls the VLM judge that evaluates each pair of generations.

| Field | Description |
|-------|-------------|
| Judge Model | OpenRouter model string for the judge, e.g. `google/gemini-3-flash-preview` |
| Runs per pair | How many times to judge each A/B pair (1–5). Odd numbers enable majority voting. |

---

### Runner
The central orchestration node. Connects everything and sets benchmark-level parameters.

| Field | Description |
|-------|-------------|
| Benchmark Name | Display name for this run |
| Mode | `Standard`, `Feedback Loop`, `Human Eval`, or `Image to SVG` |
| Temperature | Generation temperature (0–1) for all model calls |

**Modes:**
- **Standard** — Full pairwise ELO benchmark. Every model pair is judged on every prompt.
- **Feedback Loop** — Iterative refinement. Models see the judge's critique and regenerate.
- **Human Eval** — Comparisons are presented to a human for manual judging via the Human Judge interface.
- **Image to SVG** — Models receive reference images and attempt to reproduce them as SVG.

---

### Results
Terminal node — no configuration fields. Contains the **Launch Benchmark** button and a status line. When you click Launch, the flow is converted to a config object, a run is created via the API, and you're taken to the live run progress page.

---

## Connections

- Each Model node has **1 output** → connect to Runner input 1
- Prompt Pack has **1 output** → connect to Runner input 2
- Judge has **1 output** → connect to Runner input 3
- Runner has **1 output** → connect to Results input 1

Drawflow enforces directed connections. Drag from an output port (right side of a node) to an input port (left side of the destination node). You can connect multiple Model nodes to the same Runner input.

---

## Presets

Five preset flows are available in the topbar:

| Preset | Models | Prompts | Mode | Notes |
|--------|--------|---------|------|-------|
| **Quick Showdown** | 2 | 3 | Standard | Claude Sonnet vs Gemini Flash, fast run |
| **Full Standard** | 8 | 8 | Standard | Mirrors the Full Display Run benchmark data |
| **Feedback Loop** | 3 | 5 | Feedback Iteration | Tests how well models incorporate critique |
| **Human Eval** | 4 | 5 | Human Eval | Human judges pick winners manually |
| **Multi-Judge** | 3 | 3 | Standard | 3 judge runs per pair for majority consensus |

Selecting a preset clears the canvas and rebuilds it from scratch. Your changes are lost — use this as a starting point, not a save state.

---

## AI Flow Builder

The chat panel on the right side of the Flow Builder page accepts natural language instructions and applies them to the live flow.

### Example commands

```
"Compare Claude and Gemini on logo design prompts"
→ Loads Quick Showdown preset, adds logo prompts

"Add deepseek v3 to the benchmark"
→ {"action":"add_model","data":{"model-id":"deepseek/deepseek-chat-v3-0324"}}

"Switch to feedback loop mode"
→ {"action":"set_mode","data":{"mode":"feedback_iteration"}}

"Add a prompt: a detailed map of a fantasy city"
→ {"action":"add_prompt","data":{"text":"a detailed map of a fantasy city"}}

"Use gpt-4o-mini as the judge with 3 runs"
→ {"action":"set_judge","data":{"judge-model":"openai/gpt-4o-mini","judge-runs":3}}

"Name this benchmark SVG Art Shootout"
→ {"action":"set_name","data":{"name":"SVG Art Shootout"}}
```

The AI describes what it's doing in plain English and includes a JSON action block that the frontend parses and applies to the canvas automatically.

### Available actions

| Action | Data fields | Effect |
|--------|------------|--------|
| `add_model` | `model-id`, `reasoning` | Adds a new Model node |
| `add_prompt` | `text` | Adds a prompt row to the Prompt Pack |
| `set_judge` | `judge-model`, `judge-runs` | Updates the Judge node |
| `set_mode` | `mode` | Updates the Runner's mode |
| `set_name` | `name` | Updates the benchmark name |
| `clear` | — | Clears the canvas |
| `load_preset` | `name` | Loads a named preset |

---

## Flow → Config Mapping

When you click Launch, `flowToConfig()` walks the Drawflow graph and produces:

```json
{
  "name": "Quick Showdown",
  "mode": "standard",
  "models": [
    { "id": "anthropic/claude-sonnet-4-5", "reasoning_effort": "high" },
    { "id": "google/gemini-flash-1.5" }
  ],
  "prompts": [
    { "id": "<uuid>", "text": "a minimalist logo for a tech startup" },
    { "id": "<uuid>", "text": "a pelican riding a bicycle" }
  ],
  "judge": {
    "model": "google/gemini-3-flash-preview",
    "runs": 1
  },
  "generation": {
    "temperature": 0.7
  }
}
```

This is POSTed to `POST /api/runs`, then `POST /api/runs/:id/start`. The run is identical to one created through the Configure wizard — the flow builder is purely a frontend that produces the same config shape.

---

## Adding Custom Nodes (Extensions)

The Extensions system adds custom `mode` nodes (hook type: `mode`) that appear as selectable modes in the Runner node's dropdown. To use a custom extension mode:

1. Go to **Extensions** and enable a mode extension (e.g. "Ranking Judge" or "Code Generation")
2. Return to **Flow Builder** — the Runner node's mode dropdown now includes the extension's mode ID
3. Select it and launch as normal

The extension's `mode` hook function receives the same `runId`, `config`, and `helpers` that the built-in modes do.

---

## Keyboard & Mouse Controls

| Action | How |
|--------|-----|
| Pan canvas | Click and drag on empty canvas |
| Zoom | Scroll wheel |
| Move node | Click and drag node header |
| Connect nodes | Drag from output port → input port |
| Delete node | Click node to select, press `Delete` |
| Delete connection | Click the connection line |

---

## API Reference

The flow builder adds one server endpoint:

### `POST /api/flow/ai-assist`

Accepts a natural language message and returns an AI response with optional flow patch.

**Request:**
```json
{
  "message": "Add claude opus to the benchmark",
  "currentFlow": "{\"models\":[\"google/gemini-flash-1.5\"],\"promptCount\":3,...}",
  "conversation": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ]
}
```

**Response:**
```json
{
  "reply": "I'll add Claude Opus to your benchmark.\n\n```json\n{\"action\":\"add_model\",\"data\":{\"model-id\":\"anthropic/claude-opus-4-6\",\"reasoning\":\"high\"}}\n```"
}
```

The frontend parses the JSON block and calls `applyFlowPatch()` with it.
