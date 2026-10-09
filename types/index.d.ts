export type Figures = {
  ctx?: number
  usd?: number
  model: string
  dir: string
  branch?: string
  startedAt: number
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
    'status-right': { figures: Figures | null; lastPrompt: number | null; lastTurnMs: number | null; breakdown: Breakdown | null; palette: number }
  }
}
