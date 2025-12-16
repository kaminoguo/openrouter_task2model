# openrouter-task2model

MCP Server for OpenRouter model discovery. Filters models by constraints and ranks by semantic similarity.

## Installation

```json
{
  "mcpServers": {
    "openrouter-task2model": {
      "command": "npx",
      "args": ["-y", "openrouter-task2model"],
      "env": {
        "OPENROUTER_API_KEY": "sk-or-..."
      }
    }
  }
}
```

## Tools

### task2model

Recommend models for a task. Returns top 100 model IDs by default.

```json
{ "task": "Build a coding assistant with tool use" }
```

Output:
```json
{
  "task": "Build a coding assistant with tool use",
  "models": ["anthropic/claude-sonnet-4", "openai/gpt-4o", "..."],
  "count": 100,
  "price_range": "$0.10-$50/1M",
  "note": "Ranked by description similarity. Does not predict actual task performance. Benchmark before production use."
}
```

#### Options

| Parameter | Default | Description |
|-----------|---------|-------------|
| `hard_constraints.max_age_days` | 365 | Filter models older than N days |
| `hard_constraints.max_price_per_1m` | - | Max price per 1M tokens |
| `hard_constraints.required_parameters` | - | e.g. `["tools", "structured_outputs"]` |
| `hard_constraints.input_modalities` | - | e.g. `["text", "image"]` |
| `hard_constraints.providers` | - | e.g. `["anthropic", "openai"]` |
| `result.limit` | 100 | Number of models to return |
| `result.detail` | names_only | `names_only`, `minimal`, `standard`, `full` |

### get_model_profile

Get detailed info for a specific model.

```json
{ "model_id": "google/gemini-2.5-flash" }
```

### sync_catalog

Refresh the model catalog cache.

```json
{ "force": true }
```

## Known Limitations

**Semantic ranking does NOT predict actual performance.**

The ranking is based on embedding similarity between your task description and model descriptions. Model descriptions are marketing text, not benchmarks.

Example from testing:
| Model | Semantic Rank | Actual Performance |
|-------|---------------|-------------------|
| GPT-5.1-Codex-Mini | #6 | Poor (1-2 results) |
| Gemini 2.5 Flash | #77 | Best (5 results, 8s) |

"Codex" in the name matched "coding" semantically, but the model performed worse than Gemini which ranked much lower.

**Use this tool for discovery, not selection.** Get a list of candidate models, then benchmark them yourself.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENROUTER_API_KEY` | Required for semantic search |
| `CACHE_TTL_MS` | Cache TTL (default: 600000) |

## License

MIT
