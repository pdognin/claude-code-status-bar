import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { NetStats } from '../types'

const CELLS = 12
const TRACK = '#6b6b6b'
const PANE = 'ctx-breakdown'
const PALETTES = [
  { name: 'classic', stops: [[80, 200, 120], [240, 200, 60], [230, 70, 70]] },
  { name: 'ocean', stops: [[80, 220, 200], [60, 160, 240], [140, 100, 240]] },
  { name: 'fire', stops: [[250, 220, 80], [250, 140, 40], [220, 40, 40]] },
  { name: 'neon', stops: [[60, 240, 140], [60, 160, 255], [255, 70, 200]] },
  { name: 'mono', stops: [[120, 120, 120], [190, 190, 190], [255, 255, 255]] },
]
const REASONS: Record<string, string | undefined> = {
  aborted: '✋ interrupted',
  refusal: '🚫 refused',
  error: '⚠️ error',
}
// What each field shows, drawn on the line under the bar while it is hovered.
const TIPS: Record<string, string> = {
  time: 'Time your last prompt was submitted.',
  clock: 'The current time, ticking every second.',
  net_title: 'Connection stats: the model API link.',
  last_title: 'Stats for the last prompt.',
  model: 'The model answering this session.',
  dir: 'Current working directory.',
  branch: 'Current git branch.',
  ctx: 'Context window used. Click to change the color palette.',
  cost: 'Total session cost so far.',
  session: 'Time since this session started.',
  turn: 'Last prompt: wall time from submit to finish, [engine-measured turn time], and cost. While a prompt runs, its wall time counts up and the other stats wait for it to finish.',
  why: 'Why the last turn ended: interrupted, refused by the model, or an API error.',
  tokens: 'Tokens for the last turn: input (cache hits included) and output.',
  cache: "Share of the last turn's input served from the prompt cache. wrote = tokens newly written to the cache (a miss, which costs more than a hit).",
  pmodel: 'The model that answered the last prompt, shown only when it differs from the session model (after a switch).',
  five: 'Five-hour usage limit: share used and time until it resets. Shown only when the engine reports it.',
  cache_ttl: 'Prompt cache: time left before it goes cold (🔥 hot over 60% of the TTL left, 💨 cooling to 30%, 💧 melting below that, 🧊 cold), its TTL, and when it goes cold. Click to switch TTL 5m/1h. Every model request renews it, so while a prompt runs it shows 🔥 in use; new = the last prompt found it cold and wrote a fresh one.',
  weekly: 'Weekly (7-day) usage limit: share used, cost this week, and time left until it resets. The cost counts only spend this bar has seen (since it was installed), not other machines.',
  tools: 'Tool calls for this prompt, by tool (× count, red = failed or denied), and ✓ succeeded / ✗ failed.',
  totals: 'Whole session: prompts, tool calls with success rate, average cost and time per prompt, the most used tools, compactions, and interrupted prompts.',
  net_last: 'Model API: the live wait on the current request (waiting for the first token, then streaming), or how long the last request took. 🐌 and yellow past 15s, red past 30s.',
  net_ttft: 'Time to first token of the last request: how long the provider took to start answering.',
  net_avg: 'Average duration of the last 10 model requests.',
  net_max: 'Slowest of the last 10 model requests.',
  net_req: 'Model requests made this session.',
  net_slow: 'Requests that took over 15 seconds.',
  net_failed: 'Requests that failed: the stream errored, or the turn ended on an API error. Your own interrupts are not counted.',
  net_err: 'The last error and how long ago (shown for 10 minutes).',
  sw_bar: 'Show or hide this whole status bar (remembered across sessions). The buttons stay so you can bring it back.',
  sw_line: 'Show or hide the classic status line from ~/.claude/statusline.sh (remembered across sessions).',
  answer: 'Length of the last answer, in characters (k = thousands).',
  net_health: 'Connection state: ● ok, ◐ slow (a request past 15s with no first token yet, or the last request was slow), ✕ stalled with how long it has waited (no first token after 30s), ✕ errors (an error in the last 10 minutes), ○ idle before any request.',
  speed: 'Output speed of the last prompt: output tokens per second while the model was streaming. Tool time is not counted.',
  grow: 'How much the context grew during the last prompt. ⟲ compacted means the context shrank, so it was compacted.',
}

let activePalette = 0
// session cost already counted into the weekly total; spend above it is new
let countedUsd: number | undefined
// counts the prompts; a tool call whose prompt differs from the stored one starts its counts afresh
let promptSeq = 0
const openRequests = new Map<number, { startedAt: number; firstAt?: number }>()
let requestSeq = 0
let ticker: { cancel: () => void } | undefined
const TTLS = [5 * 60000, 60 * 60000]

const figures = atom({ plugin: 'status-bar', key: 'figures' } as const, null)
const palette = atom({ plugin: 'status-bar', key: 'palette' } as const, 0)
const breakdown = atom({ plugin: 'status-bar', key: 'breakdown' } as const, null)
const lastPrompt = atom({ plugin: 'status-bar', key: 'lastPrompt' } as const, null)
const costAtPrompt = atom({ plugin: 'status-bar', key: 'costAtPrompt' } as const, null)
const cacheAt = atom({ plugin: 'status-bar', key: 'cacheAt' } as const, null)
const cacheTtl = atom({ plugin: 'status-bar', key: 'cacheTtl' } as const, TTLS[0]!)
const tick = atom({ plugin: 'status-bar', key: 'tick' } as const, 0)
const promptTools = atom({ plugin: 'status-bar', key: 'promptTools' } as const, { seq: -1, counts: {} })
const sessionTools = atom({ plugin: 'status-bar', key: 'sessionTools' } as const, {})
const prompts = atom({ plugin: 'status-bar', key: 'prompts' } as const, 0)
const net = atom({ plugin: 'status-bar', key: 'net' } as const, { reqs: 0, errors: 0, slow: 0, recent: [] })
const barOn = atom({ plugin: 'status-bar', key: 'barOn' } as const, true)
const lineOn = atom({ plugin: 'status-bar', key: 'lineOn' } as const, true)
const lastTurn = atom({ plugin: 'status-bar', key: 'lastTurn' } as const, null)
const ctxAtPrompt = atom({ plugin: 'status-bar', key: 'ctxAtPrompt' } as const, null)
const turnStream = atom({ plugin: 'status-bar', key: 'turnStream' } as const, 0)
const turns = atom({ plugin: 'status-bar', key: 'turns' } as const, { n: 0, wallMs: 0, usd: 0 })
const compactions = atom({ plugin: 'status-bar', key: 'compactions' } as const, 0)
const interrupts = atom({ plugin: 'status-bar', key: 'interrupts' } as const, 0)
// a prompt is running: from its submit to the end of its turn
const running = atom({ plugin: 'status-bar', key: 'running' } as const, false)
// the running or last prompt found no warm cache, so its first request wrote a new one
const cacheNew = atom({ plugin: 'status-bar', key: 'cacheNew' } as const, false)

function gradient(t: number): string {
  const stops = (PALETTES[activePalette % PALETTES.length] ?? PALETTES[0]!).stops
  const x = Math.min(Math.max(t, 0), 1) * (stops.length - 1)
  const i = Math.min(Math.floor(x), stops.length - 2)
  const [a, b] = [stops[i] ?? [0, 0, 0], stops[i + 1] ?? stops[i] ?? [0, 0, 0]]
  const hex = (c: number) => {
    const from = a[c] ?? 0
    return Math.round(from + ((b[c] ?? 0) - from) * (x - i)).toString(16).padStart(2, '0')
  }
  return `#${hex(0)}${hex(1)}${hex(2)}`
}

function modelName(id: string): string {
  const m = /(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/.exec(id)
  if (!m) return id
  const family = m[1] ?? ''
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
}

// rounds to whole seconds first, so 119.6s reads 2m 0s rather than 1m 60s
const duration = (ms: number) => {
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const secs = Math.round(ms / 1000)
  return `${Math.floor(secs / 60)}m ${secs % 60}s`
}

const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`

// the k/M cutoff is checked on the rounded thousands, so 999,600 reads 1M rather than 1000k
const tokens = (n: number) => (Math.round(n / 1e3) >= 1e3 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))

const span = (ms: number) => {
  const m = Math.max(0, Math.floor(ms / 60000))
  const [d, h] = [Math.floor(m / 1440), Math.floor((m % 1440) / 60)]
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m % 60}m` : `${m}m`
}

const toolName = (n: string) => (n.startsWith('mcp__') ? n.split('__').pop() || n : n)

// Sums a tool-count record into calls, failures, and the tools by most used.
function summarize(counts: Record<string, [number, number]>) {
  const merged = new Map<string, { name: string; ok: number; err: number; n: number }>()
  for (const [full, [ok, err]] of Object.entries(counts)) {
    const name = toolName(full)
    const row = merged.get(name) ?? { name, ok: 0, err: 0, n: 0 }
    merged.set(name, { name, ok: row.ok + ok, err: row.err + err, n: row.n + ok + err })
  }
  const rows = [...merged.values()]
  rows.sort((a, b) => b.n - a.n)
  return { rows, calls: rows.reduce((a, r) => a + r.n, 0), errors: rows.reduce((a, r) => a + r.err, 0) }
}

// keeps only the fields whose ids are listed, in their order (a field node's key is "f-<id>")
function keep<T>(nodes: T[], ids: string[]): T[] {
  return nodes.filter(n => ids.includes(String((n as unknown as { key?: unknown } | null)?.key ?? '').replace(/^f-/, '')))
}

// a character a terminal draws two columns wide: emoji (an emoji-presentation one, or any followed by
// the emoji selector U+FE0F) and East Asian wide characters
const WIDE = /\p{Emoji_Presentation}|\p{Extended_Pictographic}️|[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{20000}-\u{3FFFD}]/u
const graphemes = new Intl.Segmenter()
// the columns a node takes when drawn: a row's children side by side, a column's widest child;
// hidden and absolutely placed boxes take none
function cols(node: RenderChildren): number {
  if (node === null || node === undefined || typeof node === 'boolean') return 0
  if (typeof node === 'number') return String(node).length
  if (typeof node === 'string') {
    let n = 0
    for (const { segment } of graphemes.segment(node)) n += WIDE.test(segment) ? 2 : 1
    return n
  }
  if (Array.isArray(node)) return node.reduce((a: number, c: RenderChildren) => a + cols(c), 0)
  const el = node as { type: string; props?: Record<string, unknown>; children?: RenderChildren[] }
  const p = el.props ?? {}
  if (p.display === 'none' || p.position === 'absolute') return 0
  const widths = (el.children ?? []).map(cols).filter(w => w > 0)
  if (el.type === 'Box' && p.flexDirection === 'column') return Math.max(0, ...widths)
  const gap = el.type === 'Box' ? Number(p.columnGap ?? p.gap ?? 0) * Math.max(0, widths.length - 1) : 0
  return widths.reduce((a, w) => a + w, 0) + gap
}

// cuts text to n columns, ending it in … when it had to cut
function clip(text: string, n: number): string {
  if (cols(text) <= n) return text
  let [out, w] = ['', 0]
  for (const { segment } of graphemes.segment(text)) {
    const sw = WIDE.test(segment) ? 2 : 1
    if (w + sw > n - 1) break
    out += segment
    w += sw
  }
  return `${out}…`
}

const SLOW_MS = 15000
const VERY_SLOW_MS = 30000

const short = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`)

// The last weekly limit the bar saw, while that week is still running.
async function savedWeekly($: EngineInterface) {
  const [percent, resetsAt] = [await $.store.get('weekPercent'), Number(await $.store.get('weekResets')) || undefined]
  if (percent === undefined || percent === null || (resetsAt !== undefined && resetsAt <= Date.now())) return undefined
  return { percent: Number(percent), resetsAt, usd: Number(await $.store.get('weekUsd')) || 0 }
}

// Reads the session figures the bar draws, at start and after every turn;
// resolves the session cost.
async function refreshFigures($: EngineInterface) {
  const { context, cost, startedAt, rateLimits } = await $.session.usage({ breakdown: 'summary' })
  const b = context.breakdown
  if (b) {
    await update($, breakdown, () => ({
      categories: b.categories.map(c => ({ name: c.name, tokens: c.tokens, color: c.color, kind: c.kind })),
      grid: b.gridRows.map(r => r.map(q => ({ color: q.color, isFilled: q.isFilled }))),
      total: b.totalTokens,
      max: b.rawMaxTokens,
      percent: b.percentage,
    }))
  }
  const model = await $.session.model()
  const dir = (await $.session.cwd()).split('/').pop() || '/'
  const git = await $.process.run(['git', 'branch', '--show-current']).catch(() => undefined)
  const branch = git?.exitCode === 0 ? git.stdout.trim() || undefined : undefined
  const week = rateLimits.find(r => r.kind === 'seven_day')
  let weekly = week && { percent: week.percentUsed, resetsAt: week.resetsAt && Number.isFinite(Date.parse(week.resetsAt)) ? Date.parse(week.resetsAt) : undefined }
  const five = rateLimits.find(r => r.kind === 'five_hour')
  const fiveHour = five && { percent: five.percentUsed, resetsAt: five.resetsAt && Number.isFinite(Date.parse(five.resetsAt)) ? Date.parse(five.resetsAt) : undefined }
  // The engine has no weekly cost, so add each session's new spend to a total kept
  // in the store, started afresh when the weekly limit resets.
  let weekUsd = Number(await $.store.get('weekUsd')) || 0
  const resets = weekly?.resetsAt
  if (resets !== undefined && Number(await $.store.get('weekResets')) !== resets) {
    weekUsd = 0
    countedUsd = cost?.usd
    await $.store.set('weekResets', resets)
  }
  if (cost?.usd !== undefined) {
    weekUsd += Math.max(0, cost.usd - (countedUsd ?? cost.usd))
    countedUsd = cost.usd
    await $.store.set('weekUsd', weekUsd)
  }
  // Keep the last known weekly limit so the bar has figures before the engine reports one.
  if (weekly) {
    await $.store.set('weekPercent', weekly.percent)
  } else {
    weekly = await savedWeekly($)
  }
  await update($, figures, () => ({ weekly: weekly && { ...weekly, usd: weekUsd }, fiveHour, ctx: context.percent, usd: cost?.usd, model, dir, branch, startedAt }))
  return cost?.usd
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    $.ui.status(undefined)
    await $.command.register({ name: 'context-pane', description: 'Open the context breakdown pane' })
    await $.command.register({ name: 'context-pane-close', description: 'Close the context breakdown pane' })
    // the classic status line script (~/.claude/statusline.sh) stays quiet while this file says off
    const flag = await $.process.run(['sh', '-c', 'cat ~/.claude/statusline.state 2>/dev/null'])
    await update($, lineOn, () => flag.stdout.trim() !== 'off')
    const savedBar = (await $.store.get('barOn')) as boolean | undefined
    await update($, barOn, () => savedBar !== false)
    const savedPalette = Number(await $.store.get('palette'))
    await update($, palette, () => (Number.isInteger(savedPalette) && savedPalette >= 0 && savedPalette < PALETTES.length ? savedPalette : 0))
    const savedTtl = Number(await $.store.get('cacheTtl'))
    await update($, cacheTtl, () => (TTLS.includes(savedTtl) ? savedTtl : TTLS[0]!))
    await refreshFigures($).catch(() => undefined)
    ticker?.cancel()
    ticker = $.clock.every(1000, () => update($, tick, n => n + 1))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    ticker?.cancel()
    return next(e)
  })

  on('command.run', { command: 'context-pane' }, async $ => {
    await refreshFigures($)
    const { isPlaced } = await $.ui.open({ id: PANE, title: 'Context' })
    return { text: isPlaced ? 'Context pane opened.' : 'No room for a pane: widen the window (110+ columns).' }
  })

  on('command.run', { command: 'context-pane-close' }, async $ => {
    await $.ui.close({ id: PANE })
    return { text: 'Context pane closed.' }
  })

  on('prompt.submit', async ($, e, next) => {
    const at = await $.clock.now()
    const { cost } = await $.session.usage()
    // a message typed into a running turn (turnId set) is part of that prompt, not a new one
    if (e.turnId === undefined) {
      promptSeq += 1
      await update($, prompts, n => n + 1)
      await update($, lastPrompt, () => at)
      await update($, running, () => true)
      const [warmAt, ttl] = [await read($, cacheAt), await read($, cacheTtl)]
      await update($, cacheNew, () => warmAt === null || at - warmAt > ttl)
      await update($, costAtPrompt, () => cost?.usd ?? null)
      const ctxNow = (await read($, breakdown))?.total ?? null
      await update($, ctxAtPrompt, () => ctxNow)
      await update($, turnStream, () => 0)
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    let failed = true
    try {
      const r = await next(e)
      failed = r.deny !== undefined || r.isError === true
      return r
    } finally {
      const bump = (c: Record<string, [number, number]>) => {
        const [ok, err] = c[e.tool] ?? [0, 0]
        return { ...c, [e.tool]: (failed ? [ok, err + 1] : [ok + 1, err]) as [number, number] }
      }
      const seq = promptSeq
      await update($, promptTools, p => ({ seq, counts: bump(p.seq === seq ? p.counts : {}) }))
      await update($, sessionTools, bump)
    }
  })

  // One model request: times the wait for the first token and the whole reply,
  // and counts a stream that throws (provider down, timeout) as an error. Requests
  // of subagents can overlap, so the live wait follows the oldest one still open.
  on('turn.step', async function* ($, e, next) {
    const id = (requestSeq += 1)
    const startedAt = await $.clock.now()
    const open: { startedAt: number; firstAt?: number } = { startedAt }
    openRequests.set(id, open)
    // the request reads the prompt cache as it starts, which renews its TTL; a subagent's
    // requests have their own prompt, so they leave the main conversation's cache alone
    if (e.agentId === undefined) await update($, cacheAt, () => startedAt)
    const show = (n: NetStats): NetStats => {
      const oldest = [...openRequests.values()].sort((x, y) => x.startedAt - y.startedAt)[0]
      return { ...n, inflight: oldest?.startedAt, firstAt: oldest?.firstAt }
    }
    await update($, net, show)
    const stream = next(e)
    let isAborted = false
    let isFailed = false
    try {
      for (;;) {
        const step = await stream.next()
        if (step.done) {
          return step.value
        }
        if (open.firstAt === undefined) {
          open.firstAt = await $.clock.now()
          await update($, net, show)
        }
        yield step.value
      }
    } catch (err) {
      isAborted = next.signal.aborted
      isFailed = !isAborted
      if (isFailed) {
        const at = await $.clock.now()
        const msg = String((err as Error)?.message ?? err).replace(/\s+/g, ' ').slice(0, 80)
        await update($, net, n => ({ ...n, errors: n.errors + 1, lastError: msg, lastErrorAt: at }))
      }
      throw err
    } finally {
      const end = await $.clock.now()
      openRequests.delete(id)
      if (!isAborted && open.firstAt !== undefined) {
        const streamed = end - open.firstAt
        await update($, turnStream, ms => ms + streamed)
      }
      await update($, net, n => {
        const ms = end - startedAt
        // an interrupted request says nothing about the provider's speed
        if (isAborted) return show(n)
        return show({
          ...n,
          reqs: n.reqs + 1,
          slow: n.slow + (ms > SLOW_MS ? 1 : 0),
          lastMs: ms,
          lastTtftMs: open.firstAt === undefined ? undefined : open.firstAt - startedAt,
          recent: isFailed ? n.recent : [...n.recent, ms].slice(-10),
        })
      })
    }
  })

  on('turn.complete', async ($, e, next) => {
    const previous = (await read($, figures))?.usd
    const usd = await refreshFigures($)
    if (e.agentId !== undefined) return next(e) // a subagent's turn is not the prompt's

    const [submittedAt, usdBefore, done] = [await read($, lastPrompt), await read($, costAtPrompt), await $.clock.now()]
    const startUsd = usdBefore ?? previous
    const ctxBefore = await read($, ctxAtPrompt)
    const ctxNow = (await read($, breakdown))?.total
    const compacted = ctxBefore !== null && ctxNow !== undefined && ctxNow < ctxBefore * 0.8
    const turnUsd = usd === undefined || startUsd === undefined ? undefined : Math.max(0, usd - startUsd)
    const wallMs = submittedAt === null ? e.durationMs : done - submittedAt
    if (compacted) await update($, compactions, c => c + 1)
    if (e.reason === 'aborted') await update($, interrupts, c => c + 1)
    await update($, turns, t0 => ({ n: t0.n + 1, wallMs: t0.wallMs + wallMs, usd: t0.usd + (turnUsd ?? 0) }))
    if (e.reason === 'error') {
      // an API error that ended the turn after retries; the step may not have thrown
      const n = await read($, net)
      if (n.lastErrorAt === undefined || done - n.lastErrorAt > 10000) {
        await update($, net, x => ({ ...x, errors: x.errors + 1, lastError: 'turn ended on an API error', lastErrorAt: done }))
      }
    }
    const u = e.usage
    const streamMs = await read($, turnStream)
    const model = await $.session.model().catch(() => undefined)
    await update($, lastTurn, () => ({
      reason: e.reason,
      wallMs,
      engineMs: e.durationMs,
      usd: turnUsd,
      input: u && u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens,
      output: u?.output_tokens,
      cacheRead: u?.cache_read_input_tokens,
      cacheWrite: u?.cache_creation_input_tokens,
      model,
      answerChars: e.answer.length,
      streamMs,
      ctxDelta: ctxBefore === null || ctxNow === undefined ? undefined : ctxNow - ctxBefore,
      compacted,
    }))
    await update($, running, () => false)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    // before the first figures arrive, draw the bar with empty starting values
    const f = (await read($, figures)) ?? {
      ctx: 0,
      usd: 0,
      model: await $.session.model().catch(() => ''),
      dir: (await $.session.cwd().catch(() => '')).split('/').pop() || '/',
      branch: undefined,
      weekly: await savedWeekly($),
      startedAt: await $.clock.now(),
    }

    const { Box, Text, Button } = $.ui.resolve(e)
    const [isBar, isLine] = [await read($, barOn), await read($, lineOn)]
    const setLine = async () => {
      const enable = !isLine
      await $.process.run(['sh', '-c', `mkdir -p ~/.claude && printf %s ${enable ? 'on' : 'off'} > ~/.claude/statusline.state`])
      await update($, lineOn, () => enable)
    }
    const switches = (
      <Box gap={1}>
        <Box key="hv-bar" hover={{ scope: 'tip-sw_bar' }}>
          <Button key="sw-bar" plain onPress={async () => {
            await $.store.set('barOn', !isBar)
            await update($, barOn, () => !isBar)
          }}>
            <Text dimColor>[bar {isBar ? '●' : '○'}]</Text>
          </Button>
        </Box>
        <Box key="hv-line" hover={{ scope: 'tip-sw_line' }}>
          <Button key="sw-line" plain onPress={setLine}>
            <Text dimColor>[line {isLine ? '●' : '○'}]</Text>
          </Button>
        </Box>
      </Box>
    )
    // narrow windows drop what would not fit, measured against the body width from the render event:
    // a right-aligned part goes when it would run into the left part (with a column between them),
    // the connection and last-prompt extras when their line overflows, and a tip that would cover the switches
    const width = (e.props as { bodyColumns?: number }).bodyColumns ?? Infinity
    const fits = (...parts: RenderChildren[]) => parts.reduce((a: number, p) => a + cols(p), 0) + parts.length - 1 <= width
    // the bottom row: the tip of the hovered field on the left, cut to the room beside the switches
    // (a hover cannot make the row taller), and the switches on the right
    const tipRoom = width - cols(switches) - 1
    const bottom = (
      <Box height={1} justifyContent="space-between">
        <Box>
          {tipRoom >= 10 && Object.entries(TIPS).map(([id, doc]) => (
            <Box key={`t-${id}`} position="absolute" top={0} left={0} display="none" hover={{ scope: `tip-${id}`, display: 'flex' }}>
              <Text dimColor italic>{clip(doc, tipRoom)}</Text>
            </Box>
          ))}
        </Box>
        {switches}
      </Box>
    )
    // a rule above the bar, top edge only, to set it apart from the output
    // (per-side borders are not allowed props, so it is a clipped row of ─)
    const rule = (
      <Box height={1} overflow="hidden">
        <Text dimColor>{'─'.repeat(500)}</Text>
      </Box>
    )
    if (!isBar) {
      return (
        <Box flexDirection="column">
          {rule}
          {bottom}
        </Box>
      )
    }
    activePalette = await read($, palette)
    await read($, tick) // redraw every second for the countdown
    const [t, promptAt, now, isRunning] = [await read($, lastTurn), await read($, lastPrompt), await $.clock.now(), await read($, running)]

    // A hoverable field: hovering it lights the tip with the same id.
    const field = (id: string, node: RenderChildren) => (
      <Box key={`f-${id}`} hover={{ scope: `tip-${id}` }}>
        {node}
      </Box>
    )
    // A line of fields, the absent ones skipped and the rest set apart by bars.
    const line = (...fields: RenderChildren[]) => lineWith(false, ...fields)
    // Same, but the first field (an icon) sits next to the second with a plain space.
    const lineWith = (tight: boolean, ...fields: RenderChildren[]) => (
      <Box>
        {fields
          .filter(Boolean)
          .flatMap((node, i) =>
            i === 0 ? [node] : [<Text key={`s${i}`} dimColor>{tight && i === 1 ? ' ' : ' | '}</Text>, node],
          )}
      </Box>
    )

    const ctx = Math.round(f.ctx ?? 0) // 0% until the first turn reports usage
    const bd = await read($, breakdown)
    const ctxUsed = tokens(bd?.total ?? 0)
    const ctxMax = bd?.max ? tokens(bd.max) : '–'
    const filled = Math.round((Math.min(ctx, 100) / 100) * CELLS)
    const cells = Array.from({ length: CELLS }, (_, i) => i)
    const elapsed = Math.max(0, Math.round((now - f.startedAt) / 1000))
    const cachePct = t?.input ? Math.round(((t.cacheRead ?? 0) / t.input) * 100) : undefined
    const [cacheStart, ttl] = [await read($, cacheAt), await read($, cacheTtl)]
    const left = cacheStart === null ? undefined : ttl - (now - cacheStart)
    const ttlLabel = ttl >= 3600000 ? '1h' : '5m'
    // warm -> cold in stages, by the share of the TTL still left: fire, smoke, melting, ice
    const share = left === undefined ? 0 : left / ttl
    const stage =
      share > 0.6 ? { icon: '🔥', color: '#98c379' }
      : share > 0.3 ? { icon: '💨', color: '#e5c07b' }
      : { icon: '💧', color: '#e06c75' }
    // "new" marks a cache the last prompt wrote afresh, having found none warm
    const isNew = (await read($, cacheNew)) ? 'new · ' : ''
    const cacheNode = (
      <Button key="ttl" plain onPress={async () => {
        const chosen = ttl === TTLS[0] ? TTLS[1]! : TTLS[0]!
        await $.store.set('cacheTtl', chosen)
        await update($, cacheTtl, () => chosen)
      }}>
        {isRunning ? (
          // each request of a running prompt renews the cache, so there is no countdown until it ends
          <Text color="#98c379">
            🔥 in use <Text dimColor>{isNew}ttl {ttlLabel}</Text>
          </Text>
        ) : left === undefined ? (
          <Text dimColor>🧊 no cache yet · ttl {ttlLabel}</Text>
        ) : left > 0 ? (
          <Text color={stage.color}>
            {stage.icon} {clock(left)} <Text dimColor>{isNew}ttl {ttlLabel} · cold at {new Date(cacheStart! + ttl).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</Text>
          </Text>
        ) : (
          <Text color="#61afef">
            🧊 cold <Text dimColor>{-left >= 3600000 ? span(-left) : clock(-left)} ago · ttl {ttlLabel}</Text>
          </Text>
        )}
      </Button>
    )
    // the tool counts belong to the current prompt only once its first tool call has landed
    const ptNow = await read($, promptTools)
    const [pt, st, nPrompts] = [summarize(ptNow.seq === promptSeq ? ptNow.counts : {}), summarize(await read($, sessionTools)), await read($, prompts)]
    const [tu, comp, intr] = [await read($, turns), await read($, compactions), await read($, interrupts)]
    const chips = (rows: ReturnType<typeof summarize>['rows'], max: number) =>
      rows.slice(0, max).flatMap(r => [
        <Text key={r.name} color={r.err > 0 ? '#e06c75' : undefined}>{r.name}×{r.n}</Text>,
        <Text key={`${r.name}-`}> </Text>,
      ])
    const more = (rows: unknown[], max: number) => (rows.length > max ? <Text dimColor>+{rows.length - max}</Text> : null)
    const okPct = st.calls > 0 ? Math.round(((st.calls - st.errors) / st.calls) * 100) : undefined
    const n = await read($, net)
    const waiting = n.inflight === undefined ? undefined : now - n.inflight
    const avg = n.recent.length > 0 ? n.recent.reduce((a, b) => a + b, 0) / n.recent.length : undefined
    const worst = n.recent.length > 0 ? Math.max(...n.recent) : undefined
    const recentErr = n.lastErrorAt !== undefined && now - n.lastErrorAt < 10 * 60000
    const netColor = waiting !== undefined ? (waiting > VERY_SLOW_MS ? '#e06c75' : waiting > SLOW_MS ? '#e5c07b' : '#61afef') : recentErr ? '#e06c75' : '#98c379'
    const started = nPrompts > 0 || n.reqs > 0 || n.inflight !== undefined || t != null
    const stalled = n.inflight !== undefined && n.firstAt === undefined && (waiting ?? 0) > VERY_SLOW_MS
    const slowNow = n.inflight !== undefined && n.firstAt === undefined && (waiting ?? 0) > SLOW_MS
    const health =
      stalled ? { text: `✕ stalled ${duration(waiting ?? 0)}`, color: '#e06c75' }
      : slowNow || (n.lastMs ?? 0) > SLOW_MS ? { text: '◐ slow', color: '#e5c07b' }
      : recentErr ? { text: '✕ errors', color: '#e06c75' }
      : n.reqs > 0 ? { text: '● ok', color: '#98c379' }
      : { text: '○ idle', color: undefined }
    const netStats = [
      field('net_health', <Text color={health.color} dimColor={!health.color}>{health.text}</Text>),
      field(
        'net_last',
        waiting !== undefined ? (
          <Text color={netColor}>
            {waiting > SLOW_MS ? '🐌' : '⏳'} {n.firstAt === undefined ? 'waiting' : 'streaming'} {duration(waiting)}
            {n.firstAt === undefined && waiting > SLOW_MS ? ' — provider slow?' : ''}
          </Text>
        ) : (
          <Text color={netColor}>{recentErr ? '🔴 ' : ''}{n.lastMs !== undefined ? duration(n.lastMs) : '0.0s'}</Text>
        ),
      ),
      n.lastTtftMs !== undefined && field('net_ttft', <Text dimColor>1st token {duration(n.lastTtftMs)}</Text>),
      avg !== undefined && field('net_avg', <Text dimColor>avg {duration(avg)}</Text>),
      worst !== undefined && field('net_max', <Text dimColor>max {duration(worst)}</Text>),
      field('net_req', <Text dimColor>{n.reqs} req</Text>),
      n.slow > 0 && field('net_slow', <Text color="#e5c07b">{n.slow} slow</Text>),
      n.errors > 0 && field('net_failed', <Text color="#e06c75">{n.errors} failed</Text>),
      recentErr && field('net_err', <Text color="#e06c75">{Math.round((now - n.lastErrorAt!) / 60000)}m ago: {n.lastError}</Text>),
    ]
    // Until the first prompt, only the label shows (no stats); afterwards just the icon and the stats.
    const title = (key: string, icon: string, label: string) => field(key, <Text dimColor>{started ? icon : `${icon} ${label}`}</Text>)
    const weeklyNode = (resets: boolean) => field(
      'weekly',
      f.weekly === undefined ? (
        <Text dimColor>📅 week – · no weekly limit data</Text>
      ) : (
        <Text color={f.weekly.percent >= 90 ? '#e06c75' : f.weekly.percent >= 70 ? '#e5c07b' : '#98c379'}>
          📅 week {f.weekly.percent}%
          {f.weekly.usd !== undefined && <Text color="#e5c07b"> · ${f.weekly.usd.toFixed(2)}</Text>}
          {resets && f.weekly.resetsAt !== undefined && (
            <Text dimColor> · resets in {span(f.weekly.resetsAt - now)} ({new Date(f.weekly.resetsAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })})</Text>
          )}
        </Text>
      ),
    )
    // the five-hour window, shown before the weekly one; absent until the engine reports it
    const fiveNode = (resets: boolean) =>
      f.fiveHour !== undefined &&
      field(
        'five',
        <Text color={f.fiveHour.percent >= 90 ? '#e06c75' : f.fiveHour.percent >= 70 ? '#e5c07b' : '#98c379'}>
          🕔 5h {f.fiveHour.percent}%
          {resets && f.fiveHour.resetsAt !== undefined && <Text dimColor> · resets in {span(f.fiveHour.resetsAt - now)}</Text>}
        </Text>,
      )
    const toolsNode =
      field(
        'tools',
        st.calls === 0 ? (
          <Text dimColor>🔧 no tool calls yet</Text>
        ) : (
          <Text>
            🔧 {pt.calls} {chips(pt.rows, 5)}
            {more(pt.rows, 5)}
            <Text color="#98c379"> ✓{pt.calls - pt.errors}</Text>
            <Text color={pt.errors > 0 ? '#e06c75' : undefined} dimColor={pt.errors === 0}> ✗{pt.errors}</Text>
          </Text>
        ),
      )
    const totalsNode =
      field(
        'totals',
        <Text dimColor>
          Σ {nPrompts} prompt{nPrompts === 1 ? '' : 's'} · {st.calls} tool calls
          {okPct !== undefined && ` (${okPct}% ok)`}
          {f.usd !== undefined && nPrompts > 0 && ` · avg $${(f.usd / nPrompts).toFixed(2)}/prompt`}
          {tu.n > 0 && ` · avg ${duration(tu.wallMs / tu.n)}/prompt`}
          {comp > 0 && ` · ⟲ ${comp} compaction${comp === 1 ? '' : 's'}`}
          {intr > 0 && ` · ✋ ${intr} interrupted`}
          {st.rows.length > 0 && ` · top: ${st.rows.slice(0, 3).map(r => `${r.name}×${r.n}`).join(' ')}`}
        </Text>,
      )
    // A line with its right-hand part pushed to the edge.
    const split = (left: RenderChildren, right: RenderChildren) => (
      <Box justifyContent="space-between">
        {left}
        {right || <Text> </Text>}
      </Box>
    )
    const why = t && REASONS[t.reason]

    const bar = (
      <Button key="bar" plain onPress={async () => {
        const chosen = (activePalette + 1) % PALETTES.length
        await $.store.set('palette', chosen)
        await update($, palette, () => chosen)
      }}>
        <Text color={gradient(0)}>●</Text>
        {cells.map(i => (
          <Text key={`c${i}`} color={i < filled ? gradient(i / (CELLS - 1)) : TRACK}>
            ▬
          </Text>
        ))}
        <Text color={gradient(1)}>●</Text>
        {ctx >= 80 && <Text color="#e06c75" bold>⚠ </Text>}
        <Text color={gradient(ctx / 100)} bold> {ctx}%</Text>
        <Text dimColor> · </Text>
        <Text color={gradient(ctx / 100)}>{ctxUsed}</Text>
        <Text dimColor>/</Text>
        <Text color={gradient(1)}>{ctxMax}</Text>
      </Button>
    )
    const turn =
      t &&
      `⚡${duration(t.wallMs ?? t.engineMs ?? 0)}` +
        (t.wallMs !== undefined && t.engineMs !== undefined ? ` [${duration(t.engineMs)}]` : '')
    const turnCost = t?.usd === undefined ? undefined : `$${t.usd.toFixed(2)}`

    const timeField = field('time', <Text dimColor>{promptAt === null ? '--:--:--' : new Date(promptAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</Text>)
    // while a prompt runs, the previous prompt's stats are hidden and the wall time counts up
    const lastStats = isRunning ? [
          timeField,
          field('turn', <Text color="#61afef">⚡ {clock(Math.max(0, now - (promptAt ?? now)))} running</Text>),
    ] : [
          timeField,
          t?.model && t.model !== f.model && field('pmodel', <Text color="#5fd7d7">[{modelName(t.model)}]</Text>),
          field('turn', <Text color={t ? '#abb2bf' : undefined} dimColor={!t}>
            {turn ?? '⚡0.0s'}
            {turnCost !== undefined && <Text color="#e5c07b"> · {turnCost}</Text>}
          </Text>),
          why && field('why', <Text color="#e06c75">{why}</Text>),
          field('tokens', <Text dimColor>↑{short(t?.input ?? 0)} ↓{short(t?.output ?? 0)}</Text>),
          t?.output && t.streamMs ? field('speed', <Text dimColor>{Math.round(t.output / (t.streamMs / 1000))} tok/s</Text>) : null,
          t?.ctxDelta !== undefined && field('grow', t.compacted ? <Text color="#e5c07b">⟲ compacted</Text> : <Text dimColor>{t.ctxDelta < 0 ? '−' : '+'}{short(Math.abs(t.ctxDelta))} ctx</Text>),
          field(
            'cache',
            <Text dimColor>
              cache {cachePct ?? 0}%
              {t?.cacheWrite ? ` · wrote ${short(t.cacheWrite)}` : ''}
            </Text>,
          ),
          field('answer', <Text dimColor>💬 {short(t?.answerChars ?? 0)}</Text>),
    ]

    // Each row takes the widest version of itself that fits the body width.
    const top = line(
      field('clock', <Text dimColor>🕰️ {new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</Text>),
      field('model', <Text color="#5fd7d7">[{modelName(f.model)}]</Text>),
      field('dir', <Text>📁 {f.dir}</Text>),
      f.branch !== undefined && field('branch', <Text>🌿 {f.branch}</Text>),
    )
    // the limits on the right of the top row: with their reset times, without them, or not at all
    const limits = (resets: boolean) => {
      const five = fiveNode(resets)
      return (
        <Box>
          {five}
          {five && <Text dimColor> | </Text>}
          {weeklyNode(resets)}
        </Box>
      )
    }
    const topRight = [limits(true), limits(false)].find(r => fits(top, r)) ?? null
    const ctxLine = line(
      bar && field('ctx', bar),
      field('cost', <Text color="#e5c07b">${(f.usd ?? 0).toFixed(2)}</Text>),
      field('session', <Text>⏱️ {Math.floor(elapsed / 60)}m {elapsed % 60}s</Text>),
      cacheNode && field('cache_ttl', cacheNode),
    )
    const ctxRight = fits(ctxLine, totalsNode) ? totalsNode : null
    // the connection and last-prompt lines fall back to their main fields when the full line overflows
    const netFull = lineWith(started, title('net_title', '🌐', 'connection stats'), ...(started ? netStats : []))
    const netLine = fits(netFull) ? netFull : lineWith(started, title('net_title', '🌐', 'connection stats'), ...(started ? keep(netStats, ['net_health', 'net_last']) : []))
    const lastFull = lineWith(started, title('last_title', '⏱️', 'last prompt stats'), ...(started ? lastStats : []))
    const lastLine = fits(lastFull) ? lastFull : lineWith(started, title('last_title', '⏱️', 'last prompt stats'), ...(started ? keep(lastStats, ['time', 'turn', 'why']) : []))
    // the tools chips go before the last-prompt extras do
    const lastRight = fits(lastLine, toolsNode) ? toolsNode : null

    return (
      <Box flexDirection="column">
        {rule}
        {split(top, topRight)}
        {split(ctxLine, ctxRight)}
        {netLine}
        {split(lastLine, lastRight)}
        {bottom}
      </Box>
    )
  })


  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const b = await read($, breakdown)

    if (b === null) {
      return <Text dimColor>No data yet: finish a turn or run /context-pane.</Text>
    }

    const rows = b.categories.filter(c => c.kind !== 'deferred')

    return (
      <Box flexDirection="column">
        <Box gap={2}>
          <Button key="close" label="Close" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
        <Text bold>
          {Math.round(b.total / 1000)}k / {Math.round(b.max / 1000)}k tokens · {b.percent}%
        </Text>
        <Box flexDirection="column" marginY={1}>
          {b.grid.map((row, y) => (
            <Text key={`r${y}`}>
              {row.map((q, x) => (
                <Text key={`q${x}`} color={q.color} dimColor={!q.isFilled}>
                  {q.isFilled ? '■ ' : '□ '}
                </Text>
              ))}
            </Text>
          ))}
        </Box>
        {rows.map(c => (
          <Text key={c.name}>
            <Text color={c.color}>■ </Text>
            {c.name}: {c.tokens.toLocaleString()} ({((c.tokens / b.max) * 100).toFixed(1)}%)
          </Text>
        ))}
      </Box>
    )
  })
}
