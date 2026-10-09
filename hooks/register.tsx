import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

const CELLS = 12
const EIGHTHS = [' ', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█']
const SMOOTH_PCT = 63
const TRACK = '#3a3a3a'
const PALETTES = [
  { name: 'classic', stops: [[80, 200, 120], [240, 200, 60], [230, 70, 70]] },
  { name: 'ocean', stops: [[80, 220, 200], [60, 160, 240], [140, 100, 240]] },
  { name: 'fire', stops: [[250, 220, 80], [250, 140, 40], [220, 40, 40]] },
  { name: 'neon', stops: [[60, 240, 140], [60, 160, 255], [255, 70, 200]] },
  { name: 'mono', stops: [[120, 120, 120], [190, 190, 190], [255, 255, 255]] },
]

let current = 0

function gradient(t: number): string {
  const stops = PALETTES[current % PALETTES.length].stops
  const x = Math.min(Math.max(t, 0), 1) * (stops.length - 1)
  const i = Math.min(Math.floor(x), stops.length - 2)
  const k = x - i
  const hex = (n: number) => Math.round(n).toString(16).padStart(2, '0')
  const [a, b] = [stops[i], stops[i + 1]]
  return '#' + [0, 1, 2].map(c => hex(a[c] + (b[c] - a[c]) * k)).join('')
}

function modelName(id: string): string {
  const m = /(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/.exec(id)
  if (!m) return id
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
}

const figures = atom({ plugin: 'status-right', key: 'figures' } as const, null)
const palette = atom({ plugin: 'status-right', key: 'palette' } as const, 0)
const PANE = 'ctx-breakdown'
const breakdown = atom({ plugin: 'status-right', key: 'breakdown' } as const, null)
const lastTurnMs = atom({ plugin: 'status-right', key: 'lastTurnMs' } as const, null)
const lastPrompt = atom({ plugin: 'status-right', key: 'lastPrompt' } as const, null)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    $.ui.status(undefined)
    await $.command.register({ name: 'context-pane', description: 'Open the context breakdown pane' })
    await $.command.register({ name: 'context-pane-close', description: 'Close the context breakdown pane' })
    const { context, cost, startedAt } = await $.session.usage()
    const model = await $.session.model()
    const dir = (await $.session.cwd()).split('/').pop() || '/'
    const git = await $.process.run(['git', 'branch', '--show-current'])
    const branch = git.exitCode === 0 ? git.stdout.trim() || undefined : undefined
    await update($, figures, () => ({ ctx: context.percent, usd: cost?.usd, model, dir, branch, startedAt }))
    return next(e)
  })

  on('command.run', { command: 'context-pane' }, async $ => {
    const { context } = await $.session.usage({ breakdown: 'summary' })
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
    const { isPlaced } = await $.ui.open({ id: PANE, title: 'Context' })
    return { text: isPlaced ? 'Context pane opened.' : 'No room for a pane: widen the window (110+ columns).' }
  })

  on('command.run', { command: 'context-pane-close' }, async $ => {
    await $.ui.close({ id: PANE })
    return { text: 'Context pane closed.' }
  })

  on('prompt.submit', async ($, e, next) => {
    const at = await $.clock.now()
    await update($, lastPrompt, () => at)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
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
    const submittedAt = await read($, lastPrompt)
    if (submittedAt !== null) {
      const done = await $.clock.now()
      await update($, lastTurnMs, () => done - submittedAt)
    }
    const model = await $.session.model()
    const dir = (await $.session.cwd()).split('/').pop() || '/'
    const git = await $.process.run(['git', 'branch', '--show-current'])
    const branch = git.exitCode === 0 ? git.stdout.trim() || undefined : undefined
    await update($, figures, () => ({ ctx: context.percent, usd: cost?.usd, model, dir, branch, startedAt }))
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const f = await read($, figures)
    if (e.props.hasSurvey || f === null) {
      return next(e)
    }

    const { Box, Text, Button } = $.ui.resolve(e)
    current = await read($, palette)
    const next_ = () => update($, palette, n => (n + 1) % PALETTES.length)
    const ctx = f.ctx
    const filled = ctx === undefined ? 0 : Math.round((Math.min(ctx, 100) / 100) * CELLS)
    const pfilled = Math.round(1 * CELLS)
    const exact = (SMOOTH_PCT / 100) * CELLS
    const whole = Math.floor(exact)
    const part = Math.round((exact - whole) * 8)
    const cells = Array.from({ length: CELLS }, (_, i) => i)
    const now = await $.clock.now()
    const promptAt = await read($, lastPrompt)
    const took = await read($, lastTurnMs)
    const tookText = took === null ? undefined : took < 60000 ? `${(took / 1000).toFixed(1)}s` : `${Math.floor(took / 60000)}m ${Math.round((took % 60000) / 1000)}s`
    const clock =
      promptAt === null
        ? undefined
        : new Date(promptAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const elapsed = Math.max(0, Math.round((now - f.startedAt) / 1000))
    const mins = Math.floor(elapsed / 60)
    const secs = elapsed % 60

    return (
      <Box flexDirection="column">
        <Box>
          {clock === undefined ? null : <Text dimColor>{clock} </Text>}
          <Text color="#5fd7d7">[{modelName(f.model)}]</Text>
          <Text> 📁 {f.dir}</Text>
          {f.branch === undefined ? null : <Text> | 🌿 {f.branch}</Text>}
        </Box>
        <Box>
          {ctx === undefined ? null : (
            <Button key="bar-real" plain onPress={next_}>
              <Text color={filled > 0 ? gradient(0) : TRACK}>●</Text>
              {cells.map(i => (
                <Text key={`c${i}`} color={i < filled ? gradient(i / (CELLS - 1)) : TRACK}>
                  ▬
                </Text>
              ))}
              <Text color={filled === CELLS ? gradient(1) : TRACK}>●</Text>
              <Text color={gradient(ctx / 100)} bold> {ctx}%</Text>
            </Button>
          )}
          {f.usd === undefined ? null : <Text dimColor> | </Text>}
          {f.usd === undefined ? null : <Text color="#e5c07b">${f.usd.toFixed(2)}</Text>}
          <Text dimColor> | </Text>
          <Text>⏱️ {mins}m {secs}s</Text>
          {tookText === undefined ? null : <Text dimColor> | </Text>}
          {tookText === undefined ? null : <Text color="#c678dd">⚡ last prompt {tookText}</Text>}
        </Box>
        <Box>
          {(
            <Button key="bar-prev" plain onPress={next_}>
              <Text color={pfilled > 0 ? gradient(0) : TRACK}>●</Text>
              {cells.map(i => (
                <Text key={`c${i}`} color={i < pfilled ? gradient(i / (CELLS - 1)) : TRACK}>
                  ▬
                </Text>
              ))}
              <Text color={pfilled === CELLS ? gradient(1) : TRACK}>●</Text>
              <Text color={gradient(1)} bold> 100% (preview) · {PALETTES[current % PALETTES.length].name}</Text>
            </Button>
          )}
        </Box>
        <Button key="bar-eighths" plain onPress={next_}>
          <Text color={gradient(0)}>●</Text>
          {cells.map(i => (
            <Text
              key={`s${i}`}
              color={i < whole ? gradient(i / (CELLS - 1)) : i === whole && part > 0 ? gradient(i / (CELLS - 1)) : TRACK}
              backgroundColor={i === whole && part > 0 ? TRACK : undefined}
            >
              {i < whole ? '█' : i === whole && part > 0 ? EIGHTHS[part] : '█'}
            </Text>
          ))}
          <Text color={TRACK}>●</Text>
          <Text color={gradient(SMOOTH_PCT / 100)} bold> {SMOOTH_PCT}% (eighths)</Text>
        </Button>
        <Button key="bar-half" plain onPress={next_}>
          <Text color={gradient(0)}>●</Text>
          {cells.map(i => {
            const t = (k: number) => gradient(k / (2 * CELLS - 1))
            const isFull = i < whole
            const isEdge = i === whole && part > 0
            return (
              <Text
                key={`h${i}`}
                color={isFull ? t(2 * i) : isEdge ? t(2 * i) : TRACK}
                backgroundColor={isFull ? t(2 * i + 1) : isEdge ? TRACK : undefined}
              >
                {isFull ? '▌' : isEdge ? EIGHTHS[part] : '█'}
              </Text>
            )
          })}
          <Text color={TRACK}>●</Text>
          <Text color={gradient(SMOOTH_PCT / 100)} bold> {SMOOTH_PCT}% (half-block)</Text>
        </Button>
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
