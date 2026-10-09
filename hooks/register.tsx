import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

const CELLS = 12
const TRACK = '#3a3a3a'
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
  answer: 'Length of the last answer, in characters (k = thousands).',
}

let activePalette = 0

const figures = atom({ plugin: 'status-bar', key: 'figures' } as const, null)
const palette = atom({ plugin: 'status-bar', key: 'palette' } as const, 0)
const breakdown = atom({ plugin: 'status-bar', key: 'breakdown' } as const, null)
const lastPrompt = atom({ plugin: 'status-bar', key: 'lastPrompt' } as const, null)
const costAtPrompt = atom({ plugin: 'status-bar', key: 'costAtPrompt' } as const, null)
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

const short = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`)

// Reads the session figures the bar draws, at start and after every turn;
// resolves the session cost.
async function refreshFigures($: EngineInterface) {
  const { context, cost, startedAt } = await $.session.usage({ breakdown: 'summary' })
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
  const git = await $.process.run(['git', 'branch', '--show-current'])
  const branch = git.exitCode === 0 ? git.stdout.trim() || undefined : undefined
  await update($, figures, () => ({ ctx: context.percent, usd: cost?.usd, model, dir, branch, startedAt }))
  return cost?.usd
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    $.ui.status(undefined)
    await $.command.register({ name: 'context-pane', description: 'Open the context breakdown pane' })
    await $.command.register({ name: 'context-pane-close', description: 'Close the context breakdown pane' })
    await refreshFigures($)
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
    await update($, lastPrompt, () => at)
    await update($, costAtPrompt, () => cost?.usd ?? null)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const previous = (await read($, figures))?.usd
    const usd = await refreshFigures($)
    if (e.agentId !== undefined) return next(e) // a subagent's turn is not the prompt's

    const [submittedAt, usdBefore, done] = [await read($, lastPrompt), await read($, costAtPrompt), await $.clock.now()]
    const startUsd = usdBefore ?? previous
    const u = e.usage
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
    const f = await read($, figures)
    if (e.props.hasSurvey || f === null) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    activePalette = await read($, palette)
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

    const ctx = f.ctx
    const filled = Math.round((Math.min(ctx ?? 0, 100) / 100) * CELLS)
    const cells = Array.from({ length: CELLS }, (_, i) => i)
    const elapsed = Math.max(0, Math.round((now - f.startedAt) / 1000))
    const cachePct = t?.input ? Math.round(((t.cacheRead ?? 0) / t.input) * 100) : undefined
    const why = t && REASONS[t.reason]

    const bar = ctx !== undefined && (
      <Button key="bar" plain onPress={() => update($, palette, n => (n + 1) % PALETTES.length)}>
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
        {line(
          promptAt !== null &&
            field('time', <Text dimColor>{new Date(promptAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>),
          field('model', <Text color="#5fd7d7">[{modelName(f.model)}]</Text>),
          field('dir', <Text>📁 {f.dir}</Text>),
          f.branch !== undefined && field('branch', <Text>🌿 {f.branch}</Text>),
        )}
        {line(
          bar && field('ctx', bar),
          f.usd !== undefined && field('cost', <Text color="#e5c07b">${f.usd.toFixed(2)}</Text>),
          field('session', <Text>⏱️ {Math.floor(elapsed / 60)}m {elapsed % 60}s</Text>),
        )}
        {line(
          turn && field('turn', <Text color="#c678dd">{turn}</Text>),
          why && field('why', <Text color="#e06c75">{why}</Text>),
          t?.input !== undefined && field('tokens', <Text dimColor>↑{short(t.input)} ↓{short(t.output ?? 0)}</Text>),
          cachePct !== undefined && field('cache', <Text dimColor>cache {cachePct}%</Text>),
          t && field('answer', <Text dimColor>💬 {short(t.answerChars)}</Text>),
        )}
        <Box height={1}>
          {Object.entries(TIPS).map(([id, doc]) => (
            <Box key={`t-${id}`} position="absolute" top={0} left={0} display="none" hover={{ scope: `tip-${id}`, display: 'flex' }}>
              <Text dimColor italic>{doc}</Text>
            </Box>
          ))}
        </Box>
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
