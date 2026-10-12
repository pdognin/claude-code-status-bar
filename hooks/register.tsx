import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginState, Register, RenderChildren, SessionRateLimit, StateValue } from 'claude-code'

import type { NetStats, ToolCounts } from '../types'

type State = PluginState['status-bar']

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
// the colors the bar draws with, for a dark terminal
const C = { red: '#e06c75', yellow: '#e5c07b', green: '#98c379', blue: '#61afef', cyan: '#5fd7d7', text: '#abb2bf' }
// help mode backgrounds: a section that a click explains, the field under the pointer, the explained section
const TINT = { row: '#2c313a', hover: '#3e4451', picked: '#4b5263' }
const REASONS: Record<string, string | undefined> = {
  aborted: '✋ interrupted',
  refusal: '🚫 refused',
  error: '⚠️ error',
}

const MINUTE = 60000
const HOUR = 60 * MINUTE
const TTLS = [5 * MINUTE, HOUR]
// a request is slow past SLOW_MS with no first token, stalled past VERY_SLOW_MS
const SLOW_MS = 15000
const VERY_SLOW_MS = 30000
// the requests the average and the max are taken over
const RECENT = 10
// how long the last error stays on the bar
const ERROR_SHOWN_MS = 10 * MINUTE
// a turn that ends on an API error this soon after a request's error is the same failure
const SAME_ERROR_MS = 10000
// A request with no reply for PROBE_AFTER_MS starts a network check, repeated every PROBE_EVERY_MS
// while the wait or the outage lasts; a check with no answer in PROBE_TIMEOUT_MS counts as offline.
const PROBE_AFTER_MS = 3000
const PROBE_EVERY_MS = 5000
const PROBE_TIMEOUT_MS = 4000
const PROBE_URL = 'https://api.anthropic.com/'

// Every field of the bar: `tip`, short enough to fit beside the switches, is drawn under the bar
// while the field is hovered; `label` follows the field in help mode; `doc`, the full text, is what
// /bar-help prints (the tip when there is none).
const FIELDS: Record<string, { tip: string; label?: string; doc?: string }> = {
  clock: {
    tip: 'Current time.',
    label: 'current time',
    doc: 'The current time, ticking every second.',
  },
  model: {
    tip: 'Model answering this session.',
    label: 'session model',
    doc: 'The model answering this session.',
  },
  dir: {
    tip: 'Current working directory.',
    label: 'working dir',
    doc: 'Current working directory.',
  },
  branch: {
    tip: 'Current git branch.',
    label: 'git branch',
    doc: 'Current git branch.',
  },
  five: {
    tip: 'Five-hour limit: share used, time to reset.',
    label: '5-hour limit used · resets in',
    doc: 'Five-hour usage limit: share used and time until it resets. Shown only when the engine reports it.',
  },
  weekly: {
    tip: 'Weekly limit: share used, cost this week, time to reset.',
    label: 'weekly limit used · cost this week · resets in',
    doc: 'Weekly (7-day) usage limit: share used, cost this week, and time left until it resets. The cost counts only spend this bar has seen (since it was installed), not other machines.',
  },
  ctx: {
    tip: 'Context window used. Click: next color palette.',
    label: 'context used · tokens / max',
    doc: 'Context window used. Click to change the color palette.',
  },
  cost: {
    tip: 'Session cost so far.',
    label: 'session cost',
    doc: 'Total session cost so far.',
  },
  session: {
    tip: 'Time since the session started.',
    label: 'session time',
    doc: 'Time since this session started.',
  },
  cache_ttl: {
    tip: 'Cache time left before cold. Click: TTL 5m/1h.',
    label: 'prompt cache: time to cold 🔥💨💧🧊 · ttl',
    doc: 'Prompt cache: time left before it goes cold (🔥 hot over 60% of the TTL left, 💨 cooling to 30%, 💧 melting below that, 🧊 cold), its TTL, and when it goes cold. Click to switch TTL 5m/1h. Every model request renews it, so while a prompt runs it shows 🔥 in use; new = the last prompt found it cold and wrote a fresh one.',
  },
  totals: {
    tip: 'Whole session: prompts, tool calls, averages, top tools.',
    label: 'session totals',
    doc: 'Whole session: prompts, tool calls with success rate, average cost and time per prompt, the most used tools, compactions, and interrupted prompts.',
  },
  net_title: {
    tip: 'Model API connection stats.',
    label: 'model API connection',
    doc: 'Connection stats: the model API link.',
  },
  net_health: {
    tip: 'Connection: ● ok, ◐ slow, ✕ offline/stalled/errors, ○ idle.',
    label: 'state: ok, slow, offline, stalled, errors, idle',
    doc: 'Connection state: ✕ offline with how long (a request got no reply for 3s and a check of the API host failed; checked every 5s until it gets through), ● ok, ◐ slow (a request past 15s with no first token yet, or the last request was slow), ✕ stalled with how long it has waited (no first token after 30s), ✕ errors (an error in the last 10 minutes), ○ idle before any request.',
  },
  net_last: {
    tip: "Live wait on the model API, or the last request's time.",
    label: 'last request, or live wait',
    doc: 'Model API: the live wait on the current request (waiting for the first token, then streaming), or how long the last request took. 🐌 and yellow past 15s, red past 30s.',
  },
  net_ttft: {
    tip: 'Time to first token of the last request.',
    label: 'time to first token',
    doc: 'Time to first token of the last request: how long the provider took to start answering.',
  },
  net_avg: {
    tip: 'Average of the last 10 model requests.',
    label: 'average of last 10',
    doc: 'Average duration of the last 10 model requests.',
  },
  net_max: {
    tip: 'Slowest of the last 10 model requests.',
    label: 'slowest of last 10',
    doc: 'Slowest of the last 10 model requests.',
  },
  net_req: {
    tip: 'Model requests this session.',
    label: 'requests',
    doc: 'Model requests made this session.',
  },
  net_slow: {
    tip: 'Requests that took over 15 seconds.',
    label: 'over 15s',
    doc: 'Requests that took over 15 seconds.',
  },
  net_failed: {
    tip: 'Requests that failed (your interrupts not counted).',
    label: 'failed requests',
    doc: 'Requests that failed: the stream errored or never replied, or the turn ended on an API error. Your own interrupts are not counted.',
  },
  net_err: {
    tip: 'Last error and how long ago (shown 10 min).',
    label: 'last error',
    doc: 'The last error and how long ago (shown for 10 minutes).',
  },
  last_title: {
    tip: 'Stats for the last prompt.',
    label: 'last prompt',
    doc: 'Stats for the last prompt.',
  },
  time: {
    tip: 'When the last prompt was submitted.',
    label: 'submitted at',
    doc: 'Time your last prompt was submitted.',
  },
  pmodel: {
    tip: "Model that answered, when not the session's.",
    label: 'answered by',
    doc: 'The model that answered the last prompt, shown only when it differs from the session model (after a switch).',
  },
  turn: {
    tip: 'Wall time [engine time] · cost; counts up while running.',
    label: 'wall time [engine time] · cost',
    doc: 'Last prompt: wall time from submit to finish, [engine-measured turn time], and cost. While a prompt runs, its wall time counts up and the other stats wait for it to finish.',
  },
  why: {
    tip: 'Why the turn ended: interrupt, refusal or API error.',
    label: 'why it ended',
    doc: 'Why the last turn ended: interrupted, refused by the model, or an API error.',
  },
  tokens: {
    tip: "Last turn's tokens: ↑ input (incl. cache), ↓ output.",
    label: 'tokens in / out',
    doc: 'Tokens for the last turn: input (cache hits included) and output.',
  },
  speed: {
    tip: 'Output tokens per second while streaming.',
    label: 'output speed',
    doc: 'Output speed of the last prompt: output tokens per second while the model was streaming. Tool time is not counted.',
  },
  grow: {
    tip: 'Context growth this prompt; ⟲ = compacted.',
    label: 'context growth',
    doc: 'How much the context grew during the last prompt. ⟲ compacted means the context shrank, so it was compacted.',
  },
  cache: {
    tip: 'Input share served from cache; wrote = new cache.',
    label: 'input from cache · written',
    doc: "Share of the last turn's input served from the prompt cache. wrote = tokens newly written to the cache (a miss, which costs more than a hit).",
  },
  answer: {
    tip: 'Length of the last answer, in characters.',
    label: 'answer length',
    doc: 'Length of the last answer, in characters (k = thousands).',
  },
  tools: {
    tip: "This prompt's tools by count; ✓ ok, ✗ failed (red).",
    label: 'tools this prompt · ✓ ok ✗ failed',
    doc: 'Tool calls for this prompt, by tool (× count, red = failed or denied), and ✓ succeeded / ✗ failed.',
  },
  sw_bar: {
    tip: 'Show or hide this bar (remembered).',
    doc: 'Show or hide this whole status bar (remembered across sessions). The buttons stay so you can bring it back.',
  },
  sw_line: {
    tip: 'Show or hide the classic status line (remembered).',
    doc: 'Show or hide the classic status line from ~/.claude/statusline.sh (remembered across sessions).',
  },
  sw_help: {
    tip: 'Help mode: click a section to explain each of its fields.',
    doc: 'Turns help mode on or off. In help mode the left and right sections of each row are tinted; click one and each of its fields is shown with a label under the bar. The context bar and the cache field only explain while help mode is on.',
  },
}

// /bar-help: the fields row by row. In help mode a row is split into its left-aligned section
// and its right-aligned one (`right`), and a click on a field explains its section.
const HELP: { title: string; row?: string; right?: string[]; ids: string[] }[] = [
  { title: 'Top row', row: 'top', right: ['five', 'weekly'], ids: ['clock', 'model', 'dir', 'branch', 'five', 'weekly'] },
  { title: 'Context row', row: 'ctx', right: ['totals'], ids: ['ctx', 'cost', 'session', 'cache_ttl', 'totals'] },
  { title: 'Connection row', row: 'net', ids: ['net_title', 'net_health', 'net_last', 'net_ttft', 'net_avg', 'net_max', 'net_req', 'net_slow', 'net_failed', 'net_err'] },
  { title: 'Last-prompt row', row: 'last', right: ['tools'], ids: ['last_title', 'time', 'pmodel', 'turn', 'why', 'tokens', 'speed', 'grow', 'cache', 'answer', 'tools'] },
  { title: 'Switches', ids: ['sw_bar', 'sw_line', 'sw_help'] },
]
// a field's section: "<row>-l" or "<row>-r"
const SECTION_OF = new Map(
  HELP.flatMap(g => (g.row === undefined ? [] : g.ids.map(id => [id, `${g.row}-${g.right?.includes(id) ? 'r' : 'l'}`] as const))),
)

// session cost already counted into the weekly total; spend above it is new
let countedUsd: number | undefined
// counts the prompts; a tool call whose prompt differs from the stored one starts its counts afresh
let promptSeq = 0
// the model requests still open
type OpenRequest = { startedAt: number; firstAt?: number }
const openRequests = new Map<number, OpenRequest>()
let requestSeq = 0
let ticker: { cancel: () => void } | undefined
// the network check: when it last ran, and whether one is still out
let probeAt = 0
let isProbing = false

const state = <K extends keyof State & string>(key: K, initial: StateValue<'status-bar', K>) => atom({ plugin: 'status-bar', key }, initial)
const figures = state('figures', null)
const palette = state('palette', 0)
const breakdown = state('breakdown', null)
const lastPrompt = state('lastPrompt', null)
const costAtPrompt = state('costAtPrompt', null)
const cacheAt = state('cacheAt', null)
const cacheTtl = state('cacheTtl', TTLS[0]!)
const tick = state('tick', 0)
const promptTools = state('promptTools', { seq: -1, counts: {} })
const sessionTools = state('sessionTools', {})
const prompts = state('prompts', 0)
const net = state('net', { reqs: 0, errors: 0, slow: 0, recent: [] })
const barOn = state('barOn', true)
const lineOn = state('lineOn', true)
const lastTurn = state('lastTurn', null)
const ctxAtPrompt = state('ctxAtPrompt', null)
// ms the main agent's model spent streaming during the running prompt
const turnStream = state('turnStream', 0)
const turns = state('turns', { n: 0, wallMs: 0, usd: 0 })
const compactions = state('compactions', 0)
const interrupts = state('interrupts', 0)
// a prompt is running: from its submit to the end of its turn
const running = state('running', false)
// the running or last prompt found no warm cache, so its first request wrote a new one
const cacheNew = state('cacheNew', false)
// help mode, and the section it explains (none until a section is clicked)
const helpOn = state('helpOn', false)
const helpSection = state('helpSection', null)

function gradient(stops: number[][], t: number): string {
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

// whole seconds as "1h 5m" or "4m 12s"
const hms = (secs: number) => {
  const [h, m] = [Math.floor(secs / 3600), Math.floor((secs % 3600) / 60)]
  return h > 0 ? `${h}h ${m}m` : `${m}m ${secs % 60}s`
}

// tenths of a second under a minute; above, rounds to whole seconds first, so 119.6s reads 2m 0s rather than 1m 60s
const duration = (ms: number) => (ms < MINUTE ? `${(ms / 1000).toFixed(1)}s` : hms(Math.round(ms / 1000)))

// a countdown or count-up: "4:07"
const clock = (ms: number) => `${Math.floor(ms / MINUTE)}:${String(Math.floor((ms % MINUTE) / 1000)).padStart(2, '0')}`

// time left to a reset, in whole minutes: "5d 2h", "2h 29m", "12m"
const span = (ms: number) => {
  const m = Math.max(0, Math.floor(ms / MINUTE))
  const [d, h] = [Math.floor(m / 1440), Math.floor((m % 1440) / 60)]
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m % 60}m` : `${m}m`
}

// a time of day: "09:10:05 PM"
const timeOfDay = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

// a count as "950", "1.5k" or "1.2M"; the k/M cutoff is checked on the rounded thousands,
// so 999,600 reads 1M rather than 1000k
const short = (n: number, digits = 1) => {
  const k = +(n / 1e3).toFixed(digits)
  return n < 1e3 ? String(n) : k < 1e3 ? `${k}k` : `${+(n / 1e6).toFixed(1)}M`
}

// a percentage of a usage limit: green, yellow from 70%, red from 90%
const limitColor = (percent: number) => (percent >= 90 ? C.red : percent >= 70 ? C.yellow : C.green)

const toolName = (n: string) => (n.startsWith('mcp__') ? n.split('__').pop() || n : n)

// Sums a tool-count record into calls, failures, and the tools by most used.
function summarize(counts: ToolCounts) {
  const merged = new Map<string, { name: string; err: number; n: number }>()
  for (const [full, [ok, err]] of Object.entries(counts)) {
    const name = toolName(full)
    const row = merged.get(name) ?? { name, err: 0, n: 0 }
    merged.set(name, { name, err: row.err + err, n: row.n + ok + err })
  }
  const rows = [...merged.values()].sort((a, b) => b.n - a.n)
  return { rows, calls: rows.reduce((a, r) => a + r.n, 0), errors: rows.reduce((a, r) => a + r.err, 0) }
}

// a character a terminal draws two columns wide: emoji (an emoji-presentation one, or any followed by
// the emoji selector U+FE0F) and East Asian wide characters
const WIDE = /\p{Emoji_Presentation}|\p{Extended_Pictographic}️|[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{20000}-\u{3FFFD}]/u
const graphemes = new Intl.Segmenter()
const charCols = (segment: string) => (WIDE.test(segment) ? 2 : 1)
// the columns a node takes when drawn: a row's children side by side, a column's widest child;
// hidden and absolutely placed boxes take none
function cols(node: RenderChildren): number {
  if (node === null || node === undefined || typeof node === 'boolean') return 0
  if (typeof node === 'number') return String(node).length
  if (typeof node === 'string') {
    let n = 0
    for (const { segment } of graphemes.segment(node)) n += charCols(segment)
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
    if (w + charCols(segment) > n - 1) break
    out += segment
    w += charCols(segment)
  }
  return `${out}…`
}

// an error as one short line
const oneLine = (err: unknown) => String((err as Error)?.message ?? err).replace(/\s+/g, ' ').slice(0, 80)

// a usage limit the engine reports, with its reset time as a timestamp
function limitOf(rateLimits: SessionRateLimit[], kind: string) {
  const r = rateLimits.find(x => x.kind === kind)
  if (r === undefined) return undefined
  const resetsAt = r.resetsAt ? Date.parse(r.resetsAt) : NaN
  return { percent: r.percentUsed, resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined }
}

// The last weekly limit the bar saw, while that week is still running.
async function savedWeekly($: EngineInterface, now: number) {
  const [percent, resetsAt] = [await $.store.get('weekPercent'), Number(await $.store.get('weekResets')) || undefined]
  if (percent === undefined || percent === null || (resetsAt !== undefined && resetsAt <= now)) return undefined
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
  const fiveHour = limitOf(rateLimits, 'five_hour')
  const week = limitOf(rateLimits, 'seven_day')
  // The engine has no weekly cost, so each session's new spend is added to a total kept in the store.
  // It starts afresh when a new week begins: the reset time moves on by more than an hour, not
  // by the few seconds it may drift between reports.
  let weekUsd = Number(await $.store.get('weekUsd')) || 0
  const usd = cost?.usd
  if (week?.resetsAt !== undefined && week.resetsAt > (Number(await $.store.get('weekResets')) || 0) + HOUR) {
    weekUsd = 0
    countedUsd = usd
    await $.store.set('weekUsd', 0)
    await $.store.set('weekResets', week.resetsAt)
  }
  if (usd !== undefined) {
    // a cost below the counted one is a new session's (after /clear), so all of it is new
    const spent = countedUsd === undefined ? 0 : usd >= countedUsd ? usd - countedUsd : usd
    countedUsd = usd
    if (spent > 0) {
      weekUsd += spent
      await $.store.set('weekUsd', weekUsd)
    }
  }
  // Keep the last known weekly limit so the bar has figures before the engine reports one.
  if (week) await $.store.set('weekPercent', week.percent)
  const weekly = week ? { ...week, usd: weekUsd } : await savedWeekly($, await $.clock.now())
  await update($, figures, () => ({ weekly, fiveHour, ctx: context.percent, usd, model, dir, branch, startedAt }))
  return usd
}

// The live wait follows the oldest request still open (subagents' requests overlap the main one's).
function withOpen(n: NetStats): NetStats {
  let oldest: OpenRequest | undefined
  for (const r of openRequests.values()) if (oldest === undefined || r.startedAt < oldest.startedAt) oldest = r
  return { ...n, inflight: oldest?.startedAt, firstAt: oldest?.firstAt }
}

// A request ended: an interrupted one says nothing about the provider; a failed one counts as an
// error and leaves the timings alone; a good one adds its time.
function settled(n: NetStats, r: OpenRequest, end: number, outcome: 'ok' | 'failed' | 'aborted', error?: string): NetStats {
  if (outcome === 'aborted') return n
  if (outcome === 'failed') return { ...n, reqs: n.reqs + 1, errors: n.errors + 1, lastError: error, lastErrorAt: end }
  const ms = end - r.startedAt
  return {
    ...n,
    reqs: n.reqs + 1,
    slow: n.slow + (ms > SLOW_MS ? 1 : 0),
    lastMs: ms,
    lastTtftMs: r.firstAt === undefined ? undefined : r.firstAt - r.startedAt,
    recent: [...n.recent, ms].slice(-RECENT),
  }
}

// What the connection row says: the live wait on the oldest open request, and the connection state.
function connection(n: NetStats, now: number) {
  const waiting = n.inflight === undefined ? undefined : now - n.inflight
  const noReplyFor = waiting !== undefined && n.firstAt === undefined ? waiting : 0
  const hasRecentError = n.lastErrorAt !== undefined && now - n.lastErrorAt < ERROR_SHOWN_MS
  const health =
    n.offlineAt !== undefined ? { text: `✕ offline ${duration(now - n.offlineAt)}`, color: C.red }
    : noReplyFor > VERY_SLOW_MS ? { text: `✕ stalled ${duration(noReplyFor)}`, color: C.red }
    : noReplyFor > SLOW_MS ? { text: '◐ slow', color: C.yellow }
    : hasRecentError ? { text: '✕ errors', color: C.red }
    : (n.lastMs ?? 0) > SLOW_MS ? { text: '◐ slow', color: C.yellow }
    : n.reqs > 0 ? { text: '● ok', color: C.green }
    : { text: '○ idle', color: undefined }
  const color =
    waiting === undefined ? (hasRecentError ? C.red : C.green)
    : waiting > VERY_SLOW_MS ? C.red
    : waiting > SLOW_MS ? C.yellow
    : C.blue
  return { waiting, noReplyFor, hasRecentError, health, color }
}

// The network check: while a request waits with no reply, or after a check failed, fetch the
// API's host now and then. Any HTTP answer means the network is up; an error or no answer
// in time marks the connection offline until a reply or a later check says otherwise.
async function probe($: EngineInterface) {
  const now = await $.clock.now()
  const n = await read($, net)
  const isWaiting = connection(n, now).noReplyFor > PROBE_AFTER_MS
  if (isProbing || (!isWaiting && n.offlineAt === undefined) || now - probeAt < PROBE_EVERY_MS) return
  isProbing = true
  probeAt = now
  try {
    const timeout = $.clock.sleep(PROBE_TIMEOUT_MS).then(() => false)
    const isUp = await Promise.race([$.http.fetch(PROBE_URL, { method: 'HEAD' }).then(() => true, () => false), timeout])
    const at = await $.clock.now()
    await update($, net, x => (isUp ? { ...x, offlineAt: undefined } : { ...x, offlineAt: x.offlineAt ?? at }))
  } finally {
    isProbing = false
  }
}

// a field of the bar: its id names its tip, label and doc
type Field = { id: string; node: RenderChildren }
// a field that may be absent
type MaybeField = Field | false | null | undefined | '' | 0
const present = (fields: MaybeField[]) => fields.filter((x): x is Field => Boolean(x))
// a section of the bar: its fields, and whether the first (an icon) sits next to the second with a plain space
type Section = { fields: Field[]; tight?: boolean }

export const register: Register = on => {
  // a hook that fails lets the event go on as if the hook were absent
  const passOn = <E, R>(_$: unknown, e: E, next: (e: E) => R) => next(e)

  on('session.start', async ($, e, next) => {
    $.ui.status(undefined)
    await $.command.register({ name: 'context-pane', description: 'Open the context breakdown pane' })
    await $.command.register({ name: 'context-pane-close', description: 'Close the context breakdown pane' })
    await $.command.register({ name: 'bar-help', description: 'Explain every field of the status bar', immediate: true })
    // the classic status line script (~/.claude/statusline.sh) stays quiet while this file says off
    const flag = await $.process.run(['sh', '-c', 'cat ~/.claude/statusline.state 2>/dev/null']).catch(() => undefined)
    await update($, lineOn, () => flag?.stdout.trim() !== 'off')
    const savedBar = await $.store.get('barOn')
    await update($, barOn, () => savedBar !== false)
    const savedPalette = Number(await $.store.get('palette'))
    await update($, palette, () => (Number.isInteger(savedPalette) && savedPalette >= 0 && savedPalette < PALETTES.length ? savedPalette : 0))
    const savedTtl = Number(await $.store.get('cacheTtl'))
    await update($, cacheTtl, () => (TTLS.includes(savedTtl) ? savedTtl : TTLS[0]!))
    // a new session's cost is counted from what it starts at; a request left open by a reloaded plugin is gone
    countedUsd = undefined
    await update($, net, withOpen)
    await refreshFigures($).catch(() => undefined)
    ticker?.cancel()
    ticker = $.clock.every(1000, async () => {
      await update($, tick, n => n + 1)
      await probe($).catch(() => undefined)
    })
    return next(e)
  }).catch(passOn)

  on('session.end', async ($, e, next) => {
    ticker?.cancel()
    return next(e)
  })

  on('command.run', { command: 'context-pane' }, async $ => {
    await refreshFigures($).catch(() => undefined)
    const { isPlaced } = await $.ui.open({ id: PANE, title: 'Context' })
    return { text: isPlaced ? 'Context pane opened.' : 'No room for a pane: widen the window (110+ columns).' }
  })

  on('command.run', { command: 'context-pane-close' }, async $ => {
    await $.ui.close({ id: PANE })
    return { text: 'Context pane closed.' }
  })

  on('command.run', { command: 'bar-help' }, async () => ({
    text: HELP.map(g => [g.title, ...g.ids.map(id => `  ${id}: ${FIELDS[id]?.doc ?? FIELDS[id]?.tip ?? ''}`)].join('\n')).join('\n\n'),
  }))

  on('prompt.submit', async ($, e, next) => {
    // a message typed into a running turn (turnId set) is part of that prompt, not a new one
    if (e.turnId === undefined) {
      const at = await $.clock.now()
      const { cost } = await $.session.usage()
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
  }).catch(passOn)

  on('tool.call', async ($, e, next) => {
    let failed = true
    try {
      const r = await next(e)
      failed = r.deny !== undefined || r.isError === true
      return r
    } finally {
      const bump = (c: ToolCounts): ToolCounts => {
        const [ok, err] = c[e.tool] ?? [0, 0]
        return { ...c, [e.tool]: failed ? [ok, err + 1] : [ok + 1, err] }
      }
      const seq = promptSeq
      await update($, promptTools, p => ({ seq, counts: bump(p.seq === seq ? p.counts : {}) }))
      await update($, sessionTools, bump)
    }
  }).catch(passOn)

  // One model request: times the wait for the first token and the whole reply, and counts one
  // that throws (provider down, timeout) or ends with no reply (retries exhausted) as an error.
  // (No .catch: replaying a stream that threw would hide the engine's own error.)
  on('turn.step', async function* ($, e, next) {
    const id = (requestSeq += 1)
    const open: OpenRequest = { startedAt: await $.clock.now() }
    openRequests.set(id, open)
    // the request reads the prompt cache as it starts, which renews its TTL; a subagent's
    // requests have their own prompt, so they leave the main conversation's cache alone
    if (e.agentId === undefined) await update($, cacheAt, () => open.startedAt)
    await update($, net, withOpen)
    let outcome: 'ok' | 'failed' | 'aborted' = 'ok'
    let error: string | undefined
    try {
      const stream = next(e)
      for (;;) {
        const step = await stream.next()
        if (step.done) {
          if (next.signal.aborted) outcome = 'aborted'
          else if (step.value.stopReason === null && open.firstAt === undefined) [outcome, error] = ['failed', 'no reply from the model API']
          return step.value
        }
        // engine chunks (the envelope, a retry marker) come without the network too:
        // only the model's own text, thinking or tool call is a first token
        if (open.firstAt === undefined && step.value.kind !== 'engine') {
          open.firstAt = await $.clock.now()
          await update($, net, n => withOpen({ ...n, offlineAt: undefined }))
        }
        yield step.value
      }
    } catch (err) {
      if (next.signal.aborted) outcome = 'aborted'
      else [outcome, error] = ['failed', oneLine(err)]
      throw err
    } finally {
      const end = await $.clock.now()
      openRequests.delete(id)
      // tokens per second are the main agent's: its output over its own streaming time
      if (outcome === 'ok' && open.firstAt !== undefined && e.agentId === undefined) {
        const streamed = end - open.firstAt
        await update($, turnStream, ms => ms + streamed)
      }
      await update($, net, n => withOpen(settled(n, open, end, outcome, error)))
    }
  })

  on('turn.complete', async ($, e, next) => {
    const previous = (await read($, figures))?.usd
    const usd = await refreshFigures($).catch(() => previous)
    if (e.agentId !== undefined) return next(e) // a subagent's turn is not the prompt's
    try {
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
        // an API error that ended the turn after retries, unless a request already counted it
        await update($, net, x =>
          x.lastErrorAt !== undefined && done - x.lastErrorAt <= SAME_ERROR_MS ? x : { ...x, errors: x.errors + 1, lastError: 'turn ended on an API error', lastErrorAt: done },
        )
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
    } finally {
      // the prompt is over even when its stats could not be gathered
      await update($, running, () => false)
    }
    return next(e)
  }).catch(passOn)

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    await read($, tick) // redraw every second for the countdowns
    const now = await $.clock.now()
    // before the first figures arrive, draw the bar with empty starting values
    const f = (await read($, figures)) ?? {
      ctx: 0,
      usd: 0,
      model: await $.session.model().catch(() => ''),
      dir: (await $.session.cwd().catch(() => '')).split('/').pop() || '/',
      branch: undefined,
      weekly: await savedWeekly($, now),
      startedAt: now,
    }
    const [isBar, isLine, isHelp, picked] = [await read($, barOn), await read($, lineOn), await read($, helpOn), await read($, helpSection)]
    const width = (e.props as { bodyColumns?: number }).bodyColumns ?? Infinity
    // the parts fit the body width side by side, with a column between them
    const fits = (...parts: RenderChildren[]) => parts.reduce((a: number, p) => a + cols(p), 0) + parts.length - 1 <= width

    // the switches, each with its hover tip
    const switchButton = (id: string, isOn: boolean, onPress: () => Promise<void>) => (
      <Box key={`hv-${id}`} hover={{ scope: `tip-sw_${id}` }}>
        <Button key={`sw-${id}`} plain onPress={onPress}>
          <Text dimColor>[{id} {isOn ? '●' : '○'}]</Text>
        </Button>
      </Box>
    )
    const switches = (
      <Box gap={1}>
        {switchButton('bar', isBar, async () => {
          await $.store.set('barOn', !isBar)
          await update($, barOn, () => !isBar)
        })}
        {switchButton('line', isLine, async () => {
          await $.process.run(['sh', '-c', `mkdir -p ~/.claude && printf %s ${isLine ? 'off' : 'on'} > ~/.claude/statusline.state`])
          await update($, lineOn, () => !isLine)
        })}
        {switchButton('help', isHelp, async () => {
          await update($, helpOn, () => !isHelp)
          await update($, helpSection, () => null)
        })}
      </Box>
    )
    // the bottom row: the tip of the hovered field on the left, cut to the room beside the switches
    // (a hover cannot make the row taller), and the switches on the right
    const tipRoom = width - cols(switches) - 1
    const bottom = (
      <Box height={1} justifyContent="space-between">
        <Box>
          {tipRoom >= 10 && Object.entries(FIELDS).map(([id, { tip }]) => (
            <Box key={`t-${id}`} position="absolute" top={0} left={0} display="none" hover={{ scope: `tip-${id}`, display: 'flex' }}>
              <Text dimColor italic>{clip(tip, tipRoom)}</Text>
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

    // help mode: a click on a field explains its section, and a second click on that section hides it
    const pick = (id: string) => async () => {
      const section = SECTION_OF.get(id) ?? null
      await update($, helpSection, s => (s === section ? null : section))
    }
    // A field drawn: hovering it lights its tip. In help mode it is also clickable (a field that is
    // already a button explains from its own press) and lit under the pointer.
    const drawField = ({ id, node }: Field) => (
      <Box key={`f-${id}`} hover={isHelp ? { scope: `tip-${id}`, backgroundColor: TINT.hover } : { scope: `tip-${id}` }}>
        {isHelp && (node as { type?: string } | null)?.type !== 'Button' ? (
          <Button key={`h-${id}`} plain onPress={pick(id)}>
            {node}
          </Button>
        ) : (
          node
        )}
      </Box>
    )
    // A section drawn: its fields set apart by bars.
    const draw = ({ fields, tight }: Section) => (
      <Box>
        {fields.flatMap((x, i) =>
          i === 0 ? [drawField(x)] : [<Text key={`s-${x.id}`} dimColor>{tight && i === 1 ? ' ' : ' | '}</Text>, drawField(x)],
        )}
      </Box>
    )
    // the first version of a section that fits beside the given parts, else the last (the narrowest)
    const firstFit = (versions: Section[], ...beside: RenderChildren[]): Section =>
      versions.find(v => fits(...beside, draw(v))) ?? versions[versions.length - 1]!
    const none: Section = { fields: [] }

    // context bar
    const paletteAt = await read($, palette)
    const stops = (PALETTES[paletteAt] ?? PALETTES[0]!).stops
    const ctx = Math.round(f.ctx ?? 0) // 0% until the first turn reports usage
    const bd = await read($, breakdown)
    const filled = Math.round((Math.min(ctx, 100) / 100) * CELLS)
    const bar = (
      <Button key="bar" plain onPress={async () => {
        if (isHelp) return pick('ctx')()
        const chosen = (paletteAt + 1) % PALETTES.length
        await $.store.set('palette', chosen)
        await update($, palette, () => chosen)
      }}>
        <Text color={gradient(stops, 0)}>●</Text>
        {Array.from({ length: CELLS }, (_, i) => (
          <Text key={`c${i}`} color={i < filled ? gradient(stops, i / (CELLS - 1)) : TRACK}>
            ▬
          </Text>
        ))}
        <Text color={gradient(stops, 1)}>●</Text>
        {ctx >= 80 && <Text color={C.red} bold>⚠ </Text>}
        <Text color={gradient(stops, ctx / 100)} bold> {ctx}%</Text>
        <Text dimColor> · </Text>
        <Text color={gradient(stops, ctx / 100)}>{short(bd?.total ?? 0, 0)}</Text>
        <Text dimColor>/</Text>
        <Text color={gradient(stops, 1)}>{bd?.max ? short(bd.max, 0) : '–'}</Text>
      </Button>
    )

    // prompt cache: warm -> cold in stages, by the share of the TTL still left: fire, smoke, melting, ice
    const isRunning = await read($, running)
    const [cacheStart, ttl] = [await read($, cacheAt), await read($, cacheTtl)]
    const ttlLabel = ttl >= HOUR ? '1h' : '5m'
    // "new" marks a cache the last prompt wrote afresh, having found none warm
    const isNew = (await read($, cacheNew)) ? 'new · ' : ''
    const cacheText = () => {
      // each request of a running prompt renews the cache, so there is no countdown until it ends
      if (isRunning) {
        return (
          <Text color={C.green}>
            🔥 in use <Text dimColor>{isNew}ttl {ttlLabel}</Text>
          </Text>
        )
      }
      if (cacheStart === null) return <Text dimColor>🧊 no cache yet · ttl {ttlLabel}</Text>
      const left = ttl - (now - cacheStart)
      if (left <= 0) {
        return (
          <Text color={C.blue}>
            🧊 cold <Text dimColor>{-left >= HOUR ? span(-left) : clock(-left)} ago · ttl {ttlLabel}</Text>
          </Text>
        )
      }
      const stage = left / ttl > 0.6 ? { icon: '🔥', color: C.green } : left / ttl > 0.3 ? { icon: '💨', color: C.yellow } : { icon: '💧', color: C.red }
      return (
        <Text color={stage.color}>
          {stage.icon} {clock(left)} <Text dimColor>{isNew}ttl {ttlLabel} · cold at {timeOfDay(cacheStart + ttl)}</Text>
        </Text>
      )
    }
    const cacheNode = (
      <Button key="ttl" plain onPress={async () => {
        if (isHelp) return pick('cache_ttl')()
        const chosen = ttl === TTLS[0] ? TTLS[1]! : TTLS[0]!
        await $.store.set('cacheTtl', chosen)
        await update($, cacheTtl, () => chosen)
      }}>
        {cacheText()}
      </Button>
    )

    // tool counts: the current prompt's belong to it only once its first tool call has landed
    const ptNow = await read($, promptTools)
    const [pt, st, nPrompts] = [summarize(ptNow.seq === promptSeq ? ptNow.counts : {}), summarize(await read($, sessionTools)), await read($, prompts)]
    const [tu, comp, intr] = [await read($, turns), await read($, compactions), await read($, interrupts)]
    const okPct = st.calls > 0 ? Math.round(((st.calls - st.errors) / st.calls) * 100) : undefined
    const chips = (rows: ReturnType<typeof summarize>['rows'], max: number) => [
      ...rows.slice(0, max).flatMap(r => [
        <Text key={r.name} color={r.err > 0 ? C.red : undefined}>{r.name}×{r.n}</Text>,
        <Text key={`${r.name}-`}> </Text>,
      ]),
      rows.length > max && <Text key="more" dimColor>+{rows.length - max}</Text>,
    ]

    const t = await read($, lastTurn)
    const promptAt = await read($, lastPrompt)
    const n = await read($, net)
    const conn = connection(n, now)
    const avg = n.recent.length > 0 ? n.recent.reduce((a, b) => a + b, 0) / n.recent.length : undefined
    const worst = n.recent.length > 0 ? Math.max(...n.recent) : undefined
    // until the first prompt, the connection and last-prompt rows show only their titles
    const started = nPrompts > 0 || n.reqs > 0 || n.inflight !== undefined || t !== null
    const title = (id: string, icon: string, label: string): Field => ({ id, node: <Text dimColor>{started ? icon : `${icon} ${label}`}</Text> })

    // top row: where and when on the left, the usage limits on the right
    const topLeft: Section = {
      fields: present([
        { id: 'clock', node: <Text dimColor>🕰️ {timeOfDay(now)}</Text> },
        { id: 'model', node: <Text color={C.cyan}>[{modelName(f.model)}]</Text> },
        { id: 'dir', node: <Text>📁 {f.dir}</Text> },
        f.branch !== undefined && { id: 'branch', node: <Text>🌿 {f.branch}</Text> },
      ]),
    }
    const limits = (resets: boolean): Section => ({
      fields: present([
        f.fiveHour !== undefined && {
          id: 'five',
          node: (
            <Text color={limitColor(f.fiveHour.percent)}>
              🕔 5h {f.fiveHour.percent}%
              {resets && f.fiveHour.resetsAt !== undefined && <Text dimColor> · resets in {span(f.fiveHour.resetsAt - now)}</Text>}
            </Text>
          ),
        },
        {
          id: 'weekly',
          node:
            f.weekly === undefined ? (
              <Text dimColor>📅 week – · no weekly limit data</Text>
            ) : (
              <Text color={limitColor(f.weekly.percent)}>
                📅 week {f.weekly.percent}%
                {f.weekly.usd !== undefined && <Text color={C.yellow}> · ${f.weekly.usd.toFixed(2)}</Text>}
                {resets && f.weekly.resetsAt !== undefined && (
                  <Text dimColor> · resets in {span(f.weekly.resetsAt - now)} ({new Date(f.weekly.resetsAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })})</Text>
                )}
              </Text>
            ),
        },
      ]),
    })

    // context row: the context and the session on the left, the session totals on the right
    const elapsed = Math.max(0, Math.round((now - f.startedAt) / 1000))
    const ctxLeft: Section = {
      fields: [
        { id: 'ctx', node: bar },
        { id: 'cost', node: <Text color={C.yellow}>${(f.usd ?? 0).toFixed(2)}</Text> },
        { id: 'session', node: <Text>⏱️ {hms(elapsed)}</Text> },
        { id: 'cache_ttl', node: cacheNode },
      ],
    }
    const totals: Section = {
      fields: [{
        id: 'totals',
        node: (
          <Text dimColor>
            Σ {nPrompts} prompt{nPrompts === 1 ? '' : 's'} · {st.calls} tool calls
            {okPct !== undefined && ` (${okPct}% ok)`}
            {f.usd !== undefined && nPrompts > 0 && ` · avg $${(f.usd / nPrompts).toFixed(2)}/prompt`}
            {tu.n > 0 && ` · avg ${duration(tu.wallMs / tu.n)}/prompt`}
            {comp > 0 && ` · ⟲ ${comp} compaction${comp === 1 ? '' : 's'}`}
            {intr > 0 && ` · ✋ ${intr} interrupted`}
            {st.rows.length > 0 && ` · top: ${st.rows.slice(0, 3).map(r => `${r.name}×${r.n}`).join(' ')}`}
          </Text>
        ),
      }],
    }

    // connection row: the state, the live wait or the last request's time, then the averages and counts
    const { waiting } = conn
    const netStats = present([
      { id: 'net_health', node: <Text color={conn.health.color} dimColor={!conn.health.color}>{conn.health.text}</Text> },
      {
        id: 'net_last',
        node:
          waiting !== undefined ? (
            <Text color={conn.color}>
              {waiting > SLOW_MS ? '🐌' : '⏳'} {n.firstAt === undefined ? 'waiting' : 'streaming'} {duration(waiting)}
              {conn.noReplyFor > SLOW_MS && n.offlineAt === undefined ? ' — provider slow?' : ''}
            </Text>
          ) : (
            <Text color={conn.color}>{conn.hasRecentError ? '🔴 ' : ''}{duration(n.lastMs ?? 0)}</Text>
          ),
      },
      n.lastTtftMs !== undefined && { id: 'net_ttft', node: <Text dimColor>1st token {duration(n.lastTtftMs)}</Text> },
      avg !== undefined && { id: 'net_avg', node: <Text dimColor>avg {duration(avg)}</Text> },
      worst !== undefined && { id: 'net_max', node: <Text dimColor>max {duration(worst)}</Text> },
      { id: 'net_req', node: <Text dimColor>{n.reqs} req</Text> },
      n.slow > 0 && { id: 'net_slow', node: <Text color={C.yellow}>{n.slow} slow</Text> },
      n.errors > 0 && { id: 'net_failed', node: <Text color={C.red}>{n.errors} failed</Text> },
      conn.hasRecentError && { id: 'net_err', node: <Text color={C.red}>{Math.round((now - n.lastErrorAt!) / MINUTE)}m ago: {n.lastError}</Text> },
    ])

    // last-prompt row: while a prompt runs, its wall time counts up and the previous prompt's stats are hidden
    const why = t && REASONS[t.reason]
    const cachePct = t?.input ? Math.round(((t.cacheRead ?? 0) / t.input) * 100) : 0
    const timeField: Field = { id: 'time', node: <Text dimColor>{promptAt === null ? '--:--:--' : timeOfDay(promptAt)}</Text> }
    const lastStats = isRunning
      ? [timeField, { id: 'turn', node: <Text color={C.blue}>⚡ {clock(Math.max(0, now - (promptAt ?? now)))} running</Text> }]
      : present([
          timeField,
          t?.model && t.model !== f.model && { id: 'pmodel', node: <Text color={C.cyan}>[{modelName(t.model)}]</Text> },
          {
            id: 'turn',
            node: (
              <Text color={t ? C.text : undefined} dimColor={!t}>
                ⚡{duration(t?.wallMs ?? t?.engineMs ?? 0)}
                {t?.wallMs !== undefined && t.engineMs !== undefined && ` [${duration(t.engineMs)}]`}
                {t?.usd !== undefined && <Text color={C.yellow}> · ${t.usd.toFixed(2)}</Text>}
              </Text>
            ),
          },
          why && { id: 'why', node: <Text color={C.red}>{why}</Text> },
          { id: 'tokens', node: <Text dimColor>↑{short(t?.input ?? 0)} ↓{short(t?.output ?? 0)}</Text> },
          !!t?.output && !!t.streamMs && { id: 'speed', node: <Text dimColor>{Math.round(t.output / (t.streamMs / 1000))} tok/s</Text> },
          t?.ctxDelta !== undefined && {
            id: 'grow',
            node: t.compacted ? <Text color={C.yellow}>⟲ compacted</Text> : <Text dimColor>{t.ctxDelta < 0 ? '−' : '+'}{short(Math.abs(t.ctxDelta))} ctx</Text>,
          },
          { id: 'cache', node: <Text dimColor>cache {cachePct}%{t?.cacheWrite ? ` · wrote ${short(t.cacheWrite)}` : ''}</Text> },
          { id: 'answer', node: <Text dimColor>💬 {short(t?.answerChars ?? 0)}</Text> },
        ])
    const tools: Section = {
      fields: [{
        id: 'tools',
        node:
          st.calls === 0 ? (
            <Text dimColor>🔧 no tool calls yet</Text>
          ) : (
            <Text>
              🔧 {pt.calls} {chips(pt.rows, 5)}
              <Text color={C.green}> ✓{pt.calls - pt.errors}</Text>
              <Text color={pt.errors > 0 ? C.red : undefined} dimColor={pt.errors === 0}> ✗{pt.errors}</Text>
            </Text>
          ),
      }],
    }

    // Each section takes the widest version of itself that fits the body width: the limits with
    // their reset times, without them, or none; the connection and last-prompt rows all their
    // fields or only the main ones; and a right-hand part goes when it would run into the left one.
    const titled = (head: Field, stats: Field[], main: string[]): Section[] => [
      { fields: [head, ...(started ? stats : [])], tight: started },
      { fields: [head, ...(started ? stats.filter(x => main.includes(x.id)) : [])], tight: started },
    ]
    const netSection = firstFit(titled(title('net_title', '🌐', 'connection stats'), netStats, ['net_health', 'net_last']))
    const lastLeft = firstFit(titled(title('last_title', '⏱️', 'last prompt stats'), lastStats, ['time', 'turn', 'why']))
    const sections: Record<string, Section> = {
      'top-l': topLeft,
      'top-r': firstFit([limits(true), limits(false), none], draw(topLeft)),
      'ctx-l': ctxLeft,
      'ctx-r': firstFit([totals, none], draw(ctxLeft)),
      'net-l': netSection,
      'last-l': lastLeft,
      'last-r': firstFit([tools, none], draw(lastLeft)),
    }
    // help mode tints each section on its own, the explained one the most,
    // so the gap between a row's two sections stays untinted
    const tinted = (id: string) => {
      const s = sections[id]
      if (s === undefined || s.fields.length === 0) return null
      return isHelp ? <Box backgroundColor={picked === id ? TINT.picked : TINT.row}>{draw(s)}</Box> : draw(s)
    }
    // A line with its right-hand part pushed to the edge.
    const split = (left: RenderChildren, right: RenderChildren) => (
      <Box justifyContent="space-between">
        {left}
        {right || <Text> </Text>}
      </Box>
    )

    // buttons drawn again as plain text, so the explanation holds no second press of the same key
    const unbutton = (node: RenderChildren): RenderChildren => {
      if (Array.isArray(node)) return node.map(unbutton)
      const el = node as { type?: string; children?: RenderChildren[] } | null
      return el?.type === 'Button' ? <Text>{(el.children ?? []).map(unbutton)}</Text> : node
    }
    // help mode, under the bar: the explained section's fields again, each followed by its label,
    // wrapped a whole field at a time to the body width, at most four lines
    const explain = (section: Section | undefined) => {
      if (section === undefined) return <Text dimColor italic>help: click a section to explain its fields; [help ●] to leave</Text>
      const lines: RenderChildren[][] = []
      let used = 0
      for (const { id, node } of section.fields) {
        const item = (
          <Box>
            <Text>{unbutton(node)}</Text>
            <Text dimColor italic> ({FIELDS[id]?.label ?? id})</Text>
          </Box>
        )
        const w = cols(item)
        const last = lines[lines.length - 1]
        if (last !== undefined && used + 3 + w <= width) {
          last.push(<Text dimColor> | </Text>, item)
          used += 3 + w
        } else {
          lines.push([item])
          used = w
        }
      }
      const shown = lines.slice(0, 4)
      if (lines.length > 4) shown[3]!.push(<Text dimColor> …</Text>)
      return (
        <Box flexDirection="column" backgroundColor={TINT.picked}>
          {shown.map(l => (
            <Box>{l}</Box>
          ))}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {rule}
        {split(tinted('top-l'), tinted('top-r'))}
        {split(tinted('ctx-l'), tinted('ctx-r'))}
        {tinted('net-l')}
        {split(tinted('last-l'), tinted('last-r'))}
        {bottom}
        {isHelp && explain(picked === null ? undefined : sections[picked])}
      </Box>
    )
  }).catch(passOn)

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
          {short(b.total, 0)} / {short(b.max, 0)} tokens · {b.percent}%
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
            {c.name}: {c.tokens.toLocaleString()} ({b.max > 0 ? ((c.tokens / b.max) * 100).toFixed(1) : '0.0'}%)
          </Text>
        ))}
      </Box>
    )
  })
}
