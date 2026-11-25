export type ModelSpec = {
  contextWindow: number
  /** USD per 1M tokens. */
  inputPerMillion: number
  outputPerMillion: number
  cacheReadPerMillion: number
  cacheWritePerMillion: number
}

const DEFAULT_MODEL_TABLE: readonly [RegExp, ModelSpec][] = [
  // OpenAI / Codex models
  [
    /gpt-5.*codex|codex/i,
    {
      contextWindow: 258_400,
      inputPerMillion: 1.5,
      outputPerMillion: 10.0,
      cacheReadPerMillion: 0.15,
      cacheWritePerMillion: 1.5
    }
  ],
  [
    /gpt-5/i,
    {
      contextWindow: 400_000,
      inputPerMillion: 1.25,
      outputPerMillion: 10.0,
      cacheReadPerMillion: 0.125,
      cacheWritePerMillion: 1.25
    }
  ],
  [
    /gpt-4\.1/i,
    {
      contextWindow: 1_000_000,
      inputPerMillion: 2.0,
      outputPerMillion: 8.0,
      cacheReadPerMillion: 0.5,
      cacheWritePerMillion: 2.0
    }
  ],
  [
    /\bo3\b|\bo4-mini\b/i,
    {
      contextWindow: 200_000,
      inputPerMillion: 2.0,
      outputPerMillion: 8.0,
      cacheReadPerMillion: 0.5,
      cacheWritePerMillion: 2.0
    }
  ],
  // Kimi models
  [
    /kimi-k2\.5|kimi-k3|kimi-for-coding|kimi-k2/i,
    {
      contextWindow: 256_000,
      inputPerMillion: 0.6,
      outputPerMillion: 2.5,
      cacheReadPerMillion: 0.15,
      cacheWritePerMillion: 0.6
    }
  ],
  [
    /moonshot-v1-128k/i,
    {
      contextWindow: 128_000,
      inputPerMillion: 0.8,
      outputPerMillion: 2.0,
      cacheReadPerMillion: 0.2,
      cacheWritePerMillion: 0.8
    }
  ],
  // Claude models (via agy / cursor)
  [
    /claude.*opus.*4/i,
    {
      contextWindow: 200_000,
      inputPerMillion: 15.0,
      outputPerMillion: 75.0,
      cacheReadPerMillion: 1.5,
      cacheWritePerMillion: 18.75
    }
  ],
  [
    /claude.*(sonnet|haiku)/i,
    {
      contextWindow: 200_000,
      inputPerMillion: 3.0,
      outputPerMillion: 15.0,
      cacheReadPerMillion: 0.3,
      cacheWritePerMillion: 3.75
    }
  ],
  // Gemini / Antigravity models
  [
    /gemini/i,
    {
      contextWindow: 1_000_000,
      inputPerMillion: 1.25,
      outputPerMillion: 10.0,
      cacheReadPerMillion: 0.3125,
      cacheWritePerMillion: 1.25
    }
  ],
  // Grok models (Cursor)
  [
    /grok/i,
    {
      contextWindow: 256_000,
      inputPerMillion: 3.0,
      outputPerMillion: 15.0,
      cacheReadPerMillion: 0.75,
      cacheWritePerMillion: 3.0
    }
  ]
]

/** Parse comma-separated `model=limit` overrides from plugin settings. */
export function parseModelWindowOverrides(raw: string | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  if (!raw) return out
  for (const part of raw.split(',')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const key = part.slice(0, eq).trim().toLowerCase()
    const val = Number(part.slice(eq + 1).trim())
    if (key && Number.isFinite(val) && val > 0) {
      out[key] = Math.round(val)
    }
  }
  return out
}

export function findModelSpec(model: string | null): ModelSpec | null {
  if (!model) return null
  for (const [pattern, spec] of DEFAULT_MODEL_TABLE) {
    if (pattern.test(model)) return spec
  }
  return null
}

export function resolveContextWindow(
  model: string | null,
  agentKind: string,
  overrides: Record<string, number>,
  explicitWindow?: number | null
): number | null {
  if (explicitWindow && explicitWindow > 0) return explicitWindow
  if (model) {
    const lower = model.toLowerCase()
    for (const [pattern, limit] of Object.entries(overrides)) {
      if (lower.includes(pattern)) return limit
    }
    const spec = findModelSpec(model)
    if (spec) return spec.contextWindow
  }
  const byAgent = overrides[agentKind.toLowerCase()]
  if (byAgent) return byAgent
  switch (agentKind.toLowerCase()) {
    case 'codex':
      return 258_400
    case 'kimi':
      return 256_000
    case 'antigravity':
    case 'agy':
      return 1_000_000
    case 'cursor':
      return 200_000
    default:
      return null
  }
}

export function estimateCostUsd(
  model: string | null,
  tokens: {
    inputUncached: number
    output: number
    reasoning: number
    cacheRead: number
    cacheWrite: number
  }
): number | null {
  const spec = findModelSpec(model)
  if (!spec) return null
  const outTotal = tokens.output + tokens.reasoning
  const usd =
    (tokens.inputUncached * spec.inputPerMillion +
      outTotal * spec.outputPerMillion +
      tokens.cacheRead * spec.cacheReadPerMillion +
      tokens.cacheWrite * spec.cacheWritePerMillion) /
    1_000_000
  return Number.isFinite(usd) ? usd : null
}
