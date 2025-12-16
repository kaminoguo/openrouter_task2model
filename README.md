# openrouter-task2model

MCP Server to find the best AI model for your task. Searches 300+ OpenRouter models.

## Installation

### Claude Code

```bash
claude mcp add openrouter-task2model -e OPENROUTER_API_KEY=sk-or-... -- npx -y openrouter-task2model
```

### Manual Configuration

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

## Design Philosophy

**The AI decides which model to use, not the embeddings.**

Price limits, age filters, and semantic search narrow down 300+ models to ~100 candidates. From there, the AI uses its own knowledge to decide which models to benchmark. The ranking within those 100 is not a quality indicator - it just helps reduce the search space.

Think of it as: price + date + embeddings filter, AI selects.

## Tools

### task2model

Find models for a task. Returns top 100 model IDs.

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

**Semantic ranking does NOT predict performance.**

The ranking is based on model descriptions (marketing text), not benchmarks. Example:

| Model | Semantic Rank | Actual Performance |
|-------|---------------|-------------------|
| GPT-5.1-Codex-Mini | #6 | Poor |
| Gemini 2.5 Flash | #77 | Best |

However, both models are in the top 100 candidates. The AI can pick either one to test - **ranking within the 100 is not a quality signal**. The AI should use its own judgment to select from the pool.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENROUTER_API_KEY` | Required for semantic search |
| `CACHE_TTL_MS` | Cache TTL (default: 600000) |

## License

MIT
