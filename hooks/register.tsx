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
  model: 'The model answering this session.',
  dir: 'Current working directory.',
  branch: 'Current git branch.',
  ctx: 'Context window used. Click to change the color palette.',
  cost: 'Total session cost so far.',
  session: 'Time since this session started.',
  turn: 'Last prompt: wall time from submit to finish, [engine-measured turn time], and cost.',
  why: 'Why the last turn ended: interrupted, refused by the model, or an API error.',
  tokens: 'Tokens for the last turn: input (cache hits included) and output.',
  cache: "Share of the last turn's input served from the prompt cache.",
  cache_ttl: 'Prompt cache: time left before it goes cold (🔥 hot over 60% of the TTL left, 💨 cooling to 30%, 💧 melting below that, 🧊 cold), its TTL, and when it goes cold. Click to switch TTL 5m/1h. Each finished turn refreshes it.',
  weekly: 'Weekly (7-day) usage limit: share used, cost this week, and time left until it resets. The cost counts only spend this bar has seen (since it was installed), not other machines.',
  tools: 'Tool calls for this prompt, by tool (× count, red = failed or denied), and ✓ succeeded / ✗ failed.',
  totals: 'Whole session: prompts, tool calls with success rate, average cost per prompt, and the most used tools.',
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

const duration = (ms: number) =>
  ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`

const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`

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

const SLOW_MS = 15000
const VERY_SLOW_MS = 30000

const short = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`)

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
  const weekly = week && { percent: week.percentUsed, resetsAt: week.resetsAt && Number.isFinite(Date.parse(week.resetsAt)) ? Date.parse(week.resetsAt) : undefined }
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
  await update($, figures, () => ({ weekly: weekly && { ...weekly, usd: weekUsd }, ctx: context.percent, usd: cost?.usd, model, dir, branch, startedAt }))
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
      await update($, costAtPrompt, () => cost?.usd ?? null)
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
    if (e.reason === 'error') {
      // an API error that ended the turn after retries; the step may not have thrown
      const n = await read($, net)
      if (n.lastErrorAt === undefined || done - n.lastErrorAt > 10000) {
        await update($, net, x => ({ ...x, errors: x.errors + 1, lastError: 'turn ended on an API error', lastErrorAt: done }))
      }
    }
    const u = e.usage
    if (u) await update($, cacheAt, () => done) // any request touching the cache renews its TTL
    await update($, lastTurn, () => ({
      reason: e.reason,
      wallMs: submittedAt === null ? e.durationMs : done - submittedAt,
      engineMs: e.durationMs,
      usd: usd === undefined || startUsd === undefined ? undefined : Math.max(0, usd - startUsd),
      input: u && u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens,
      output: u?.output_tokens,
      cacheRead: u?.cache_read_input_tokens,
      answerChars: e.answer.length,
    }))
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
      weekly: undefined,
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
    // the bottom row: the tip of the hovered field on the left, the switches on the right
    const bottom = (
      <Box height={1} justifyContent="space-between">
        <Box>
          {Object.entries(TIPS).map(([id, doc]) => (
            <Box key={`t-${id}`} position="absolute" top={0} left={0} display="none" hover={{ scope: `tip-${id}`, display: 'flex' }}>
              <Text dimColor italic>{doc}</Text>
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
    const [t, promptAt, now] = [await read($, lastTurn), await read($, lastPrompt), await $.clock.now()]

    // A hoverable field: hovering it lights the tip with the same id.
    const field = (id: string, node: RenderChildren) => (
      <Box key={`f-${id}`} hover={{ scope: `tip-${id}` }}>
        {node}
      </Box>
    )
    // A line of fields, the absent ones skipped and the rest set apart by bars.
    const line = (...fields: RenderChildren[]) => (
      <Box>
        {fields
          .filter(Boolean)
          .flatMap((node, i) => (i === 0 ? [node] : [<Text key={`s${i}`} dimColor> | </Text>, node]))}
      </Box>
    )

    const ctx = Math.round(f.ctx ?? 0) // 0% until the first turn reports usage
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
    const cacheNode = (
      <Button key="ttl" plain onPress={async () => {
        const chosen = ttl === TTLS[0] ? TTLS[1]! : TTLS[0]!
        await $.store.set('cacheTtl', chosen)
        await update($, cacheTtl, () => chosen)
      }}>
        {left === undefined ? (
          <Text dimColor>🧊 no cache yet · ttl {ttlLabel}</Text>
        ) : left > 0 ? (
          <Text color={stage.color}>
            {stage.icon} {clock(left)} <Text dimColor>ttl {ttlLabel} · cold at {new Date(cacheStart! + ttl).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</Text>
          </Text>
        ) : (
          <Text color="#61afef">
            🧊 cold <Text dimColor>{-left >= 3600000 ? span(-left) : clock(-left)} ago · ttl {ttlLabel}</Text>
          </Text>
        )}
      </Button>
    )
    const [pt, st, nPrompts] = [summarize((await read($, promptTools)).counts), summarize(await read($, sessionTools)), await read($, prompts)]
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
    const netFields = [
            field(
              'net_last',
              waiting !== undefined ? (
                <Text color={netColor}>
                  {waiting > SLOW_MS ? '🐌' : '⏳'} {n.firstAt === undefined ? 'waiting' : 'streaming'} {duration(waiting)}
                  {n.firstAt === undefined && waiting > SLOW_MS ? ' — provider slow?' : ''}
                </Text>
              ) : (
                <Text color={netColor}>{recentErr ? '🔴' : '🌐'} {n.lastMs !== undefined ? duration(n.lastMs) : '–'}</Text>
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
    const weeklyNode = field(
      'weekly',
      f.weekly === undefined ? (
        <Text dimColor>📅 week – · no weekly limit data</Text>
      ) : (
        <Text color={f.weekly.percent >= 90 ? '#e06c75' : f.weekly.percent >= 70 ? '#e5c07b' : '#98c379'}>
          📅 week {f.weekly.percent}%
          {f.weekly.usd !== undefined && <Text color="#e5c07b"> · ${f.weekly.usd.toFixed(2)}</Text>}
          {f.weekly.resetsAt !== undefined && (
            <Text dimColor> · resets in {span(f.weekly.resetsAt - now)} ({new Date(f.weekly.resetsAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })})</Text>
          )}
        </Text>
      ),
    )
    const toolsNode =
      field(
        'tools',
        <Text>
          🔧 {pt.calls} {chips(pt.rows, 5)}
          {more(pt.rows, 5)}
          <Text color="#98c379"> ✓{pt.calls - pt.errors}</Text>
          <Text color={pt.errors > 0 ? '#e06c75' : undefined} dimColor={pt.errors === 0}> ✗{pt.errors}</Text>
        </Text>,
      )
    const totalsNode =
      field(
        'totals',
        <Text dimColor>
          Σ {nPrompts} prompt{nPrompts === 1 ? '' : 's'} · {st.calls} tool calls
          {okPct !== undefined && ` (${okPct}% ok)`}
          {f.usd !== undefined && nPrompts > 0 && ` · avg $${(f.usd / nPrompts).toFixed(2)}/prompt`}
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
        <Text color={filled > 0 ? gradient(0) : TRACK}>●</Text>
        {cells.map(i => (
          <Text key={`c${i}`} color={i < filled ? gradient(i / (CELLS - 1)) : TRACK}>
            ▬
          </Text>
        ))}
        <Text color={filled === CELLS ? gradient(1) : TRACK}>●</Text>
        <Text color={gradient(ctx / 100)} bold> {ctx}%</Text>
      </Button>
    )
    const turn =
      t &&
      `⚡ ${duration(t.wallMs ?? t.engineMs ?? 0)}` +
        (t.wallMs !== undefined && t.engineMs !== undefined ? ` [${duration(t.engineMs)}]` : '') +
        (t.usd === undefined ? '' : ` · $${t.usd.toFixed(2)}`)

    return (
      <Box flexDirection="column">
        {rule}
        {split(
          line(
            field('time', <Text dimColor>{promptAt === null ? '--:--' : new Date(promptAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>),
            field('model', <Text color="#5fd7d7">[{modelName(f.model)}]</Text>),
            field('dir', <Text>📁 {f.dir}</Text>),
            f.branch !== undefined && field('branch', <Text>🌿 {f.branch}</Text>),
          ),
          weeklyNode,
        )}
        {split(
          line(
            bar && field('ctx', bar),
            field('cost', <Text color="#e5c07b">${(f.usd ?? 0).toFixed(2)}</Text>),
            field('session', <Text>⏱️ {Math.floor(elapsed / 60)}m {elapsed % 60}s</Text>),
            cacheNode && field('cache_ttl', cacheNode),
          ),
          totalsNode,
        )}
        {netFields && line(...netFields)}
        {split(
          line(
            field('turn', <Text color={t ? '#abb2bf' : undefined} dimColor={!t}>{turn ?? '⚡ 0.0s · $0.00'}</Text>),
            why && field('why', <Text color="#e06c75">{why}</Text>),
            field('tokens', <Text dimColor>↑{short(t?.input ?? 0)} ↓{short(t?.output ?? 0)}</Text>),
            field('cache', <Text dimColor>cache {cachePct ?? 0}%</Text>),
            field('answer', <Text dimColor>💬 {short(t?.answerChars ?? 0)}</Text>),
          ),
          toolsNode,
        )}
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
