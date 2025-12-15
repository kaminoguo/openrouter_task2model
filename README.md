# openrouter-task2model

An MCP (Model Context Protocol) Server that fetches the latest OpenRouter model catalog, filters models by declarative constraints (TaskSpec), and generates request skeletons for selected candidates.

**Key Features:**
- Real-time model catalog from OpenRouter API
- Declarative constraint-based filtering (no AI summaries)
- Request skeleton generation with provider routing configuration
- Freshness gate ensures you always work with up-to-date data

## Installation & Usage

### Run with npx

```bash
# Without API key (limited functionality)
npx -y openrouter-task2model

# With API key (recommended)
OPENROUTER_API_KEY=sk-or-... npx -y openrouter-task2model
```

### Configure in MCP Client

Add to your MCP configuration (e.g., Claude Desktop, Cursor, etc.):

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

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENROUTER_API_KEY` | No | OpenRouter API key. Enables access to all endpoints. |
| `CACHE_TTL_MS` | No | Cache TTL in milliseconds (default: 600000 = 10 min) |
| `CACHE_DIR` | No | Cache directory (default: `~/.cache/openrouter-task2model/`) |
| `LOG_LEVEL` | No | Log level: `debug`, `info`, `warn`, `error` (default: `info`) |

## MCP Tools

### 1. `sync_catalog`

Refresh the OpenRouter models catalog cache.

**Input:**
```json
{
  "force": false
}
```

**Output:**
```json
{
  "model_count": 250,
  "fetched_at": "2025-01-15T10:30:00.000Z",
  "source": "live",
  "auth_used": true
}
```

### 2. `get_model_profile`

Get detailed profile of a specific model.

**Input:**
```json
{
  "model_id": "anthropic/claude-sonnet-4.5",
  "include_endpoints": true,
  "include_parameters": false
}
```

**Output:**
```json
{
  "model": {
    "id": "anthropic/claude-sonnet-4.5",
    "name": "Claude Sonnet 4.5",
    "context_length": 200000,
    "pricing": { "prompt": "0.000003", "completion": "0.000015" },
    "supported_parameters": ["tools", "tool_choice", "response_format", "reasoning"]
  },
  "endpoints": [...],
  "fetched_at": "2025-01-15T10:30:00.000Z",
  "auth_used": true
}
```

### 3. `task2model` (Main Tool)

Recommend models based on task constraints. Returns top-K candidates with request skeletons.

**Input (TaskSpec):**
```json
{
  "task": "Build an agentic coding assistant with tool use",
  "hard_constraints": {
    "min_context_length": 128000,
    "input_modalities": ["text", "image"],
    "output_modalities": ["text"],
    "required_parameters": ["tools", "tool_choice", "response_format"],
    "max_price": {
      "prompt_per_1m": 5.0,
      "completion_per_1m": 20.0
    },
    "min_age_days": 30,
    "exclude_free": true,
    "providers": ["anthropic", "openai", "google", "mistral", "deepseek"]
  },
  "preferences": {
    "prefer_newer": true,
    "routing": "price",
    "prefer_exacto_for_tools": true,
    "top_provider_only": false
  },
  "result": {
    "limit": 5,
    "include_endpoints": false,
    "include_parameters": false,
    "include_request_skeleton": true,
    "force_refresh": false,
    "detail": "standard"
  }
}
```

**Output (Task2ModelResult):**
```json
{
  "task": "Build an agentic coding assistant with tool use",
  "shortlist": [
    {
      "model_id": "anthropic/claude-sonnet-4.5",
      "name": "Claude Sonnet 4.5",
      "created": 1736899200,
      "context_length": 200000,
      "age_days": 45,
      "pricing": { "prompt": "0.000003", "completion": "0.000015" },
      "modalities": { "input": ["text", "image"], "output": ["text"] },
      "supported_parameters": ["tools", "tool_choice", "response_format", "reasoning"],
      "why_selected": ["supports tools+tool_choice+response_format", "context>=128k", "within budget"],
      "request_skeleton": {
        "model": "anthropic/claude-sonnet-4.5:exacto",
        "messages": [],
        "provider": {
          "require_parameters": true,
          "allow_fallbacks": true,
          "sort": "price"
        }
      }
    }
  ],
  "excluded_summary": {
    "total_models": 250,
    "after_hard_filter": 15,
    "excluded_by": {
      "missing_required_parameters": 180,
      "context_too_small": 45,
      "input_modality_mismatch": 10,
      "too_new": 20,
      "free_model": 15,
      "provider_not_allowed": 30
    }
  },
  "catalog": {
    "fetched_at": "2025-01-15T10:30:00.000Z",
    "cache_age_ms": 5000,
    "source": "cache",
    "auth_used": true
  }
}
```

## TaskSpec Schema

### Full Schema

```typescript
type TaskSpec = {
  // Natural language task description (required)
  task: string;

  // Hard constraints - models must satisfy ALL
  hard_constraints?: {
    min_context_length?: number;
    input_modalities?: Array<"text"|"image"|"audio"|"video">;
    output_modalities?: Array<"text"|"image"|"audio"|"video">;
    required_parameters?: string[];  // e.g. ["tools", "tool_choice", "response_format"]
    max_price?: {
      prompt_per_1m?: number;      // USD per 1M tokens
      completion_per_1m?: number;  // USD per 1M tokens
      request?: number;            // USD per request
    };
    // Quality/reliability filters
    min_age_days?: number;         // Exclude models newer than N days (filter untested)
    exclude_free?: boolean;        // Skip $0 pricing models (often unreliable)
    providers?: string[];          // Whitelist providers e.g. ["anthropic", "openai", "google"]
  };

  // Preferences - affect sorting
  preferences?: {
    prefer_newer?: boolean;              // default: true
    routing?: "price"|"throughput"|"latency";  // default: "price"
    prefer_exacto_for_tools?: boolean;   // default: true
    top_provider_only?: boolean;         // default: false
  };

  // Result configuration
  result?: {
    limit?: number;                      // default: 8
    include_endpoints?: boolean;         // default: false
    include_parameters?: boolean;        // default: false
    include_request_skeleton?: boolean;  // default: true
    force_refresh?: boolean;             // default: false
    detail?: "minimal"|"standard"|"full"; // default: "standard" - output verbosity
  };
};
```

### Detail Levels

| Level | Description |
|-------|-------------|
| `minimal` | ~8 lines per model: id, name, price, context, supports, age_days |
| `standard` | ~25 lines: + modalities, why_selected, risks, request_skeleton |
| `full` | ~180 lines: raw OpenRouter API response |

**Minimal output example:**
```json
{
  "model_id": "google/gemini-2.5-flash",
  "name": "Gemini 2.5 Flash",
  "price": { "prompt": 0.30, "completion": 2.50 },
  "context": 1048576,
  "supports": ["tools", "structured_outputs"],
  "age_days": 45
}
```

### Common Parameters

| Parameter | Description |
|-----------|-------------|
| `tools` | Function calling / tool use |
| `tool_choice` | Control tool selection behavior |
| `response_format` | JSON mode / structured output |
| `structured_outputs` | Strict JSON schema validation |
| `reasoning` | Extended thinking / chain-of-thought |
| `temperature` | Sampling temperature |
| `max_tokens` | Maximum completion tokens |

## Caching & Freshness

- **Default TTL:** 10 minutes
- **Force refresh:** Set `result.force_refresh: true` in TaskSpec
- **Manual sync:** Use `sync_catalog` tool with `force: true`

Every `task2model` call includes catalog freshness info:
```json
{
  "catalog": {
    "fetched_at": "2025-01-15T10:30:00.000Z",
    "cache_age_ms": 5000,
    "source": "cache",  // or "live"
    "auth_used": true
  }
}
```

## Request Skeleton

The generated request skeleton is designed to be used directly with OpenRouter:

```json
{
  "model": "anthropic/claude-sonnet-4.5:exacto",
  "messages": [],
  "provider": {
    "require_parameters": true,
    "allow_fallbacks": true,
    "sort": "price"
  }
}
```

Key features:
- **`:exacto` variant:** Auto-applied when `required_parameters` includes `tools`/`tool_choice` and `prefer_exacto_for_tools` is true
- **`require_parameters: true`:** Ensures providers support all requested parameters
- **`sort`:** Based on routing preference (price/throughput/latency)

## Error Handling

All errors are structured:

```json
{
  "code": "AUTH_REQUIRED",
  "message": "API key required for this operation",
  "details": {
    "hint": "Set OPENROUTER_API_KEY environment variable"
  }
}
```

Error codes:
- `AUTH_REQUIRED` - API key needed
- `NETWORK_ERROR` - Connection failed
- `UPSTREAM_ERROR` - OpenRouter API error
- `INVALID_INPUT` - Invalid TaskSpec or parameters

## License

MIT
