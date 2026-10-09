export type Figures = {
  ctx?: number
  usd?: number
  model: string
  dir: string
  branch?: string
  startedAt: number
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

export type Breakdown = {
  categories: { name: string; tokens: number; color: string; kind: string }[]
  grid: { color: string; isFilled: boolean }[][]
  total: number
  max: number
  percent: number
}

declare module 'claude-code' {
  interface PluginState {
    'status-bar': { figures: Figures | null; lastPrompt: number | null; costAtPrompt: number | null; lastTurn: LastTurn | null; breakdown: Breakdown | null; palette: number }
  }
}
