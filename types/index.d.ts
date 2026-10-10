export type Figures = {
  ctx?: number
  usd?: number
  model: string
  dir: string
  branch?: string
  startedAt: number
  weekly?: { percent: number; resetsAt?: number }
}

export type LastTurn = {
  reason: string
  wallMs?: number
  engineMs?: number
  usd?: number
  input?: number
  output?: number
  cacheRead?: number
  answerChars: number
}

/** Model API request health, from the turn.step stream. */
export type NetStats = {
  inflight?: number
  firstAt?: number
  reqs: number
  errors: number
  slow: number
  lastMs?: number
  lastTtftMs?: number
  recent: number[]
  lastError?: string
  lastErrorAt?: number
}

/** Per tool name: [succeeded, failed or denied]. */
export type ToolCounts = Record<string, [number, number]>

export type Breakdown = {
  categories: { name: string; tokens: number; color: string; kind: string }[]
  grid: { color: string; isFilled: boolean }[][]
  total: number
  max: number
  percent: number
}

declare module 'claude-code' {
  interface PluginState {
    'status-bar': { figures: Figures | null; lastPrompt: number | null; costAtPrompt: number | null; lastTurn: LastTurn | null; breakdown: Breakdown | null; palette: number; cacheAt: number | null; cacheTtl: number; tick: number; promptTools: { seq: number; counts: ToolCounts }; sessionTools: ToolCounts; prompts: number; net: NetStats; barOn: boolean; lineOn: boolean }
  }
}
