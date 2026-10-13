# status-bar: design

This document explains how the `status-bar` mod is designed: what it shows, where each figure comes from, when it is refreshed, and why it was built this way. It is written for a developer who wants to change the bar or understand a figure on it.

All code lives in `status-bar/hooks/register.tsx`. State types are in `status-bar/types/index.d.ts`. The repo history (`git log` inside `status-bar/`) records each step, and this document names the commit where a decision was made.

---

## 1. Overview

The bar is a band drawn above Claude Code's prompt. It has a rule, four rows of figures, a bottom row with hover tips and switches, and, in help mode, an explanation area under it.

```
─────────────────────────────────────────────────────────────────────────────────────────────────────────
🕰️ 09:50:11 PM | [Opus 5.5] | 📁 status-bar | 🌿 status-bar-health-stats    🕔 5h 24% · resets in 2h 29m | 📅 week 6% · $9.61 · resets in 5d 2h (Sat 12:00 AM)
●▬▬▬▬▬▬▬▬▬▬▬▬● 31% · 62k/200k | $4.12 | ⏱️ 1h 5m | 🔥 3:41 ttl 5m · cold at 09:54:00 PM    Σ 14 prompts · 96 tool calls (98% ok) · avg $0.29/prompt · …
🌐 ● ok | 2.5s | 1st token 0.7s | avg 5.1s | max 18.5s | 17 req | 1 slow
⏱️ 09:48:02 PM | ⚡1m 12s [1m 9s] · $0.41 | ↑64.2k ↓1.9k | 41 tok/s | +3.1k ctx | cache 96% | 💬 2.3k    🔧 7 Bash×4 Read×2 Edit×1 ✓7 ✗0
<hover tip of the field under the pointer>                                                   [bar ●] [line ●] [help ○]
```

| Row | Left section | Right section |
|---|---|---|
| **Top** | where and when: clock, model, folder, git branch | usage limits: 5-hour and weekly |
| **Context** | context window bar, session cost, session time, prompt cache | session totals (Σ) |
| **Connection** | state of the model API connection, live wait or last request time, averages and counts | – |
| **Last prompt** | when it was sent, how long it took and cost, tokens, speed, context growth, cache share, answer length | the prompt's tools |
| **Bottom** | the hovered field's tip | the switches `[bar] [line] [help]` |

Each row's left section is pushed to the left edge and its right section to the right edge. When the window is too narrow, parts are dropped by measured width (section 9).

### Design goals

1. **Glanceable.** Every figure fits in one band above the prompt; no pane or command is needed to see it.
2. **Honest.** A figure that is unknown shows a starting value (`0.0s`, `$0.00`, `🧊 no cache yet`) or is hidden, never a guess. Approximate figures (weekly cost) say so in their docs.
3. **Cheap.** About 3 ms per render, once a second (measured, see section 12). No polling of anything expensive.
4. **Out of the model's context.** The bar draws in the UI only. Help is given in the bar itself (hover tips, help mode), not in the transcript; `/bar-help` is the one exception, used only when the user wants the model to know.
5. **Robust.** A failure inside the bar must never block Claude Code: every hook lets the event go on if the bar fails (section 11).

---

## 2. Architecture

### 2.1 Plugin layout

```
status-bar/
├── .claude-plugin/plugin.json   name, version, description, types path
├── .claude-plugin/types/        generated engine typings (gitignored)
├── hooks/hooks.json             { "modules": ["./register.tsx"] }: the entry the engine loads
├── hooks/register.tsx           the whole bar
├── types/index.d.ts             the bar's state types (augments PluginState)
└── tsconfig.json                typecheck config (extends the generated one)
```

The only check is the typecheck: `npx tsc -p tsconfig.json` inside `status-bar/` (exit 0, no output).

### 2.2 Layout of `register.tsx`

| Part | What it holds |
|---|---|
| Constants | `PALETTES`, colors `C`, help tints `TINT`, `REASONS`, time thresholds (`SLOW_MS`, `PROBE_*`, …) |
| `FIELDS` | one entry per field: `tip` (hover), `label` (help mode), `doc` (`/bar-help`) |
| `HELP`, `SECTION_OF` | the fields row by row, and which section each belongs to |
| Module state | `countedUsd`, `promptSeq`, `openRequests`, `ticker`, probe state |
| Atoms | the bar's state, one `state(key, initial)` per value |
| Formatting helpers | `hms`, `duration`, `clock`, `span`, `timeOfDay`, `short`, `limitColor`, `modelName`, `gradient` |
| Width helpers | `cols`, `clip`, `charCols`, `WIDE` |
| Data helpers | `summarize` (tools), `limitOf`, `savedWeekly`, `refreshFigures` |
| Connection helpers | `withOpen`, `settled`, `connection`, `probe` |
| `register` | the hooks: session, commands, prompt, tool, model request, turn, render, pane |

### 2.3 Engine events used

| Event | What the bar does there |
|---|---|
| `session.start` | registers commands, restores saved settings, reads the figures, starts the 1-second ticker |
| `session.end` | stops the ticker |
| `prompt.submit` | marks a new prompt: count, submit time, cost and context at submit, cache state, `running = true` |
| `tool.call` | counts each tool call as ok or failed, for the prompt and the session |
| `turn.step` | one model request: times it, renews the cache clock, detects failures |
| `turn.complete` | re-reads the figures and records the last prompt's stats; `running = false` |
| `command.run` | `/context-pane`, `/context-pane-close`, `/bar-help` |
| `ui.render` `AbovePrompt` | draws the bar |
| `ui.render` `Pane` | draws the context breakdown pane |

### 2.4 Where state lives

Three kinds of storage, each chosen for how long a value must live:

| Kind | API | Lives | Used for |
|---|---|---|---|
| **Atoms** | `atom`, `read`, `update` | the session; reading one in the render makes the bar redraw when it changes | everything the bar draws: figures, last turn, connection stats, tool counts, switches |
| **Plugin store** | `$.store.get/set` | across sessions | user choices (`barOn`, `palette`, `cacheTtl`) and the weekly total (`weekUsd`, `weekResets`, `weekPercent`) |
| **Module variables** | plain `let` | the loaded code; reset when the plugin reloads | bookkeeping no one draws: `openRequests`, `promptSeq`, `countedUsd`, probe timing |

One more piece of state is outside the plugin: `~/.claude/statusline.state` (`on`/`off`), which the classic shell status line reads (section 8.2).

### 2.5 The render loop

- A `$.clock.every(1000, …)` ticker bumps the `tick` atom each second. The render reads `tick`, so the bar redraws every second; that is what makes the clock, the countdowns and the live wait move.
- The same ticker runs the network check (section 6.4) when one is due.
- Every other change (a turn ending, a tool call landing) updates an atom the render reads, so the bar also redraws at once on events.
- The render returns `next(e)` when the engine is showing a survey (`e.props.hasSurvey`), leaving that space to the engine.

---

## 3. Top row

### 3.1 Clock `🕰️ 09:50:11 PM`

- **Source:** `$.clock.now()` at each render.
- **Refresh:** every second (the ticker).
- **Format:** `toLocaleTimeString` with hours, minutes, seconds (`timeOfDay`), so it follows the system's 12/24-hour setting.

### 3.2 Model `[Opus 5.5]`

- **Source:** `$.session.model()`, read in `refreshFigures()`.
- **Refresh:** at session start and at the end of each turn (section 10).
- **Format:** `modelName()` turns an id like `claude-opus-5-5` into `Opus 5.5`; an id it does not recognise is shown as is.
- **Limit:** after `/model`, the bar shows the old model until the next turn ends.

### 3.3 Folder `📁 status-bar`

- **Source:** `$.session.cwd()`, the session's working directory as an absolute path. The bar shows only its last part: `cwd.split('/').pop() || '/'` (at `/` the last part is empty, so it shows `/`).
- **Refresh:** at session start and at the end of each turn; before the first read, the render reads `$.session.cwd()` itself.
- **Note:** Claude Code moves the session's working directory when a Bash command `cd`s, so the folder follows the session, not the folder `claude` was started in. Two folders with the same name look alike, since only the last part is shown.

### 3.4 Git branch `🌿 status-bar-health-stats`

- **Source:** `$.process.run(['git', 'branch', '--show-current'])`, run in the session's working directory (the default when no `cwd` is given).
- **Shown only when** git exits 0 and prints a name. It is hidden outside a git repo, when git fails, and on a detached HEAD (git prints nothing there, as mid-rebase or after checking out a commit).
- **Refresh:** at session start and at the end of each turn. A `git checkout` in another terminal shows only after the next turn.
- **Cost:** about 5 ms per call on the author's laptop (50 runs, median 5.5 ms in a repo, 5.2 ms outside one). It reads `.git/HEAD` only, so the repo's size does not matter.
- **Not done (offered):** re-read folder and branch every 5 seconds on the ticker, so they follow changes between turns.

### 3.5 Five-hour limit `🕔 5h 24% · resets in 2h 29m`

- **Source:** `$.session.usage().rateLimits`, the entry of kind `five_hour` (`limitOf()`): `percentUsed`, and `resetsAt` parsed into a timestamp.
- **Shown only when** the engine reports it.
- **Color:** `limitColor()`: green, yellow from 70%, red from 90% (the same thresholds as the classic shell status line).
- **Reset time:** `span()`: whole minutes, `5d 2h`, `2h 29m` or `12m`.

### 3.6 Weekly limit `📅 week 6% · $9.61 · resets in 5d 2h (Sat 12:00 AM)`

- **Percent and reset:** the `seven_day` rate limit, as for the five-hour one.
- **Cost this week:** the engine reports only the *session's* cost, so the bar keeps its own weekly total in the store:
  - `weekUsd` is the total; `countedUsd` (module variable) is the session cost already added to it.
  - At each refresh, new spend `= cost − countedUsd` is added. A cost *below* `countedUsd` means a new session (after `/clear`), so all of it is new.
  - At session start `countedUsd` is reset, so a resumed session's past cost is not counted twice.
  - The total resets when a new week begins: the reported `resetsAt` moves forward by **more than an hour** past the stored `weekResets`. An earlier version reset on *any* change, which would wipe the total if the engine's reset time drifted by seconds (fixed in `bc9d206`).
- **Before the engine reports a limit** (at startup), the last known one is drawn from the store (`savedWeekly()`), unless its week has already ended.
- **Shown always:** with no data it reads `📅 week – · no weekly limit data`.
- **Approximate by design:** it counts only spend this bar has seen. It starts at $0 when installed, misses other machines, and can drift with concurrent sessions. The docs text says so.

---

## 4. Context row

### 4.1 Context bar `●▬▬▬▬▬▬▬▬▬▬▬▬● 31% · 62k/200k`

- **Percent:** `context.percent` from `$.session.usage()`, rounded. `0%` until the first turn reports usage.
- **Tokens:** `breakdown.totalTokens` / `breakdown.rawMaxTokens`, from `$.session.usage({ breakdown: 'summary' })`, formatted with `short(n, 0)` (`62k`, `1M`).
- **Drawing:** 12 cells (`CELLS`). A filled cell takes the palette's color at its position; an empty one is `TRACK` grey (`#6b6b6b`, chosen to stay visible on a dark terminal; an earlier `#3a3a3a` was nearly invisible). The end caps take the palette's first and last colors; the percent and used tokens take the color at the fill level.
- **Warning:** a red `⚠` from 80%.
- **Click:** next palette (classic, ocean, fire, neon, mono), saved in the store. In help mode the click explains instead (section 7).
- **Gradient:** `gradient(stops, t)` blends linearly between the palette's three stops.

### 4.2 Session cost `$4.12`

- **Source:** `cost.usd` from `$.session.usage()`, refreshed at the end of each turn.

### 4.3 Session time `⏱️ 1h 5m`

- **Source:** `usage.startedAt` (the session's launch, or for a resumed session its first launch), against the clock at each render.
- **Format:** `hms()`: `4m 12s` under an hour, `1h 5m` from an hour.

### 4.4 Prompt cache `🔥 3:41 ttl 5m · cold at 09:54:00 PM`

The bar estimates how long the prompt cache stays warm, so the user knows whether the next prompt will be cheap.

- **Cache clock:** `cacheAt` is set at the start of every *main agent* model request (`turn.step` with no `agentId`). Each request reads the cache, which renews its TTL. Subagents' requests have their own prompt, so they leave it alone.
- **TTL:** the bar cannot read the real TTL, so the user chooses it: 5 minutes or 1 hour. Click the field to switch; the choice is saved in the store.
- **States:**
  | While | Shows |
  |---|---|
  | a prompt runs | `🔥 in use` (every request renews it, so there is no countdown) |
  | no request yet | `🧊 no cache yet` |
  | over 60% of the TTL left | `🔥` countdown, green |
  | 30–60% left | `💨` countdown, yellow |
  | under 30% left | `💧` countdown, red |
  | expired | `🧊 cold N ago`, blue |
- **`new`:** set at submit when no warm cache was there (`cacheAt` unset or older than the TTL), so the prompt's first request wrote a fresh one, which costs more.

### 4.5 Session totals `Σ 14 prompts · 96 tool calls (98% ok) · …`

Right-aligned, built from counters kept by the hooks:

| Part | Source |
|---|---|
| prompts | `prompts` atom, +1 at each `prompt.submit` without a `turnId` |
| tool calls, `% ok` | `sessionTools`, counted as in section 5.5 |
| `avg $/prompt` | session cost / prompts |
| `avg time/prompt` | `turns` atom: sum of wall times / number of turns |
| `⟲ N compactions` | `compactions` atom (section 5.7) |
| `✋ N interrupted` | `interrupts` atom: turns that ended `aborted` |
| `top:` | the three most used tools this session |

---

## 5. Last-prompt row

While a prompt runs, the row shows only its submit time and a live `⚡ m:ss running` count-up; the previous prompt's stats are hidden, so they are never mistaken for the current one's (`d631124`). When it ends, the row shows that prompt's stats.

A message typed into a running turn (`prompt.submit` with a `turnId`) is part of that prompt, not a new one.

| Field | Shows | Source |
|---|---|---|
| title `⏱️` | `⏱️ last prompt stats` before the first prompt, then `⏱️` alone | – |
| `time` | when the prompt was submitted | `$.clock.now()` at `prompt.submit` |
| `pmodel` | the model that answered, when not the session's | `$.session.model()` at turn end |
| `turn` | `⚡1m 12s [1m 9s] · $0.41`: wall time, [engine time], cost | wall = submit → `turn.complete`; engine = `e.durationMs`; cost = session cost now − cost at submit |
| `why` | `✋ interrupted`, `🚫 refused`, `⚠️ error` | `e.reason` (hidden when the turn completed normally) |
| `tokens` | `↑64.2k ↓1.9k` | `e.usage`: input + cache reads + cache writes; output |
| `speed` | `41 tok/s` | output tokens / the main agent's streaming time (5.3) |
| `grow` | `+3.1k ctx`, or `⟲ compacted` | context tokens at turn end − at submit (5.4) |
| `cache` | `cache 96% · wrote 2.1k` | cache reads / input; cache writes |
| `answer` | `💬 2.3k` | `e.answer.length`, in characters |
| `tools` (right) | `🔧 7 Bash×4 Read×2 … ✓7 ✗0` | `promptTools` (5.5) |

### 5.1 Wall time and engine time

Wall time runs from the user's submit to `turn.complete`, which is what the user waited. Engine time is the engine's own `durationMs` for the turn. Showing both shows time spent outside the turn proper (hooks, queueing).

### 5.2 Cost of a prompt

The cost at submit is saved (`costAtPrompt`); at turn end the session cost is re-read and the difference is the prompt's cost. If no cost was saved, the previous figure is used.

### 5.3 Tokens per second

Each main-agent request adds its streaming time (first token → end) to `turnStream`, which is reset at submit. Subagents' requests are not added (`bc9d206`), since the output tokens are the main agent's. Interrupted and failed requests are not added either.

### 5.4 Context growth and compaction

`ctxAtPrompt` holds the context tokens at submit. At turn end the bar compares: a drop below 80% of the starting size means the context was compacted, which shows `⟲ compacted` and counts in the session totals.

### 5.5 Tools

- **Counting:** `tool.call` wraps every tool call. A call counts as failed when it was denied, returned `isError`, or threw.
- **Per prompt:** each prompt gets a number (`promptSeq`). The counts are stored with the number of the prompt they belong to, so the first tool call of a new prompt starts the counts afresh; before it, the row shows nothing for the new prompt.
- **Names:** MCP tools (`mcp__server__tool`) are shortened to their last part, and counts of the same short name are merged.
- **Chips:** the five most used, `Name×N`, red when any failed; `+N` for the rest; then `✓ok ✗failed`.

### 5.6 Known limit: `pmodel`

The session model is read at the same moment for the top row and for `pmodel`, so in practice they are equal and `pmodel` rarely appears. To show the model that really answered (a fallback model, for instance), it would need to come from the per-request usage in `turn.step`.

---

## 6. Connection row

The connection row tells whether the model API is answering, and how fast.

### 6.1 Request tracking

Every model request goes through `turn.step`, which the bar wraps:

1. At the start, the request is added to `openRequests` with its start time.
2. The first chunk that is the model's own (text, thinking, a tool call) sets its first-token time. **Engine chunks do not count**: they include retry markers, which arrive even with no network, and counting them made an offline request look like it was streaming (`369df8d`).
3. At the end the request is settled (`settled()`):
   | Outcome | Counted as |
   |---|---|
   | **ok** | +1 request; its time joins the last 10 (`RECENT`); +1 slow if over 15 s |
   | **failed**: the stream threw, or it ended with no reply at all (`stopReason` null and no content, after the engine gave up retrying) | +1 request, +1 error with its message; timings unchanged |
   | **aborted**: the user interrupted | nothing: it says nothing about the provider |
4. A turn that ends with `reason: 'error'` counts one more error, unless a request already counted one in the last 10 s (`SAME_ERROR_MS`).

Subagents' requests can overlap the main one's, so the live wait follows the **oldest** open request (`withOpen()`).

### 6.2 The fields

| Field | Shows |
|---|---|
| title `🌐` | `🌐 connection stats` before the first prompt, then `🌐` alone |
| `net_health` | the state (6.3) |
| `net_last` | while a request is open: `⏳ waiting 4.2s` (no first token yet) or `⏳ streaming 4.2s`, `🐌` and `— provider slow?` past 15 s; otherwise the last request's time, with `🔴` after a recent error |
| `net_ttft` | time to first token of the last request |
| `net_avg`, `net_max` | average and slowest of the last 10 good requests |
| `net_req` | requests this session |
| `net_slow` | requests over 15 s |
| `net_failed` | failed requests |
| `net_err` | the last error and how long ago, for 10 minutes |

### 6.3 Connection state

Worked out in `connection()`, first match wins:

| State | When |
|---|---|
| `✕ offline 12s` | a network check failed (6.4), and no reply or check got through since |
| `✕ stalled 34s` | the oldest open request has had no first token for over 30 s |
| `◐ slow` | the oldest open request has had no first token for over 15 s |
| `✕ errors` | an error in the last 10 minutes |
| `◐ slow` | the last good request took over 15 s |
| `● ok` | at least one request, none of the above |
| `○ idle` | no request yet |

A recent error outranks a slow last request: an error is the more important news (`bc9d206`).

### 6.4 Network check (offline detection)

Without the check, an outage looks like a slow provider for 15–30 s, and the bar cannot tell the two apart.

- **When:** from the ticker, when the oldest open request has had no reply for 3 s (`PROBE_AFTER_MS`), or while the bar already thinks it is offline; at most every 5 s (`PROBE_EVERY_MS`); one at a time.
- **What:** `$.http.fetch('https://api.anthropic.com/', { method: 'HEAD' })`, through the host, with no credentials. Any HTTP answer means the network is up; an error or no answer within 4 s (`PROBE_TIMEOUT_MS`) means offline.
- **Clearing:** the first token of any request, or a check that gets through.
- **Cost:** none while things are fine: it runs only during a wait or an outage.
- **Limit:** an organization policy that refuses web fetches would make every check fail, so the bar would show offline during long waits.

---

## 7. Help

Three levels of help, from lightest to heaviest:

### 7.1 Hover tips

Hovering any field shows its `tip` on the bottom row, left of the switches.

- Each field's box has `hover={{ scope: 'tip-<id>' }}`; each tip is an absolutely placed, hidden box that a hover on its scope shows. This is the engine's way of reacting to hover without a redraw.
- A hover cannot make a row taller, so a tip is cut with `…` to the room beside the switches (`ef35d8b`), and skipped only when under 10 columns are left. Tips were shortened to about 60 columns (`22fed42`) so this rarely happens.

### 7.2 Help mode `[help ●]`

Help mode explains a whole section at once, in the bar, without touching the transcript.

- Each section is tinted (`TINT.row`); the field under the pointer is lit (`TINT.hover`).
- Clicking any field picks its section (`SECTION_OF`); the picked section is tinted more (`TINT.picked`), and under the bar its fields are drawn again, each followed by its `label`, wrapped a field at a time, at most 4 lines. Clicking the same section again un-picks it.
- The context bar and the cache field normally act on click (palette, TTL); in help mode they explain instead.
- Selection is by section, not by row (`25d7a1a`), at the user's request: a row's left and right parts are about different things.

### 7.3 `/bar-help`

Prints every field's full `doc` (or its tip when it has none), row by row, as command output.

**Decision:** that output reaches the model's context. So `/bar-help` is kept for when the user wants the model to know; help mode is the everyday help.

### 7.4 Alternatives rejected

- **A help pane:** panes need 110+ columns, which is exactly when help is least needed; a narrow window, where fields are dropped, is when it is most needed.
- **A `[help]` button that runs `/bar-help`:** `$.command.run` skips the caller's own hooks, so the plugin's button could not reach its own command ("no command.run hook answered it").
- **A whole row as one button:** a Button's children may only be strings and Text, so each field is its own button instead.

---

## 8. Bottom row and switches

### 8.1 `[bar ●/○]`

Shows or hides the four rows (saved in the store). When hidden, the rule and the bottom row stay, so the bar can be brought back.

### 8.2 `[line ●/○]`

Turns the classic shell status line (`~/.claude/statusline.sh`, set as `statusLine` in `~/.claude/settings.json`) on or off. The plugin writes `on` or `off` to `~/.claude/statusline.state`; the script's first line exits when the file says `off`. A file is used because the script runs outside the plugin and cannot read its store.

### 8.3 `[help ●/○]`

Help mode (7.2). Turning it on or off clears the picked section.

### 8.4 The rule

A row of `─` above the bar, clipped to the width, sets it apart from the output. Per-side borders are not allowed props, so it is drawn as text.

---

## 9. Narrow windows

The bar measures what it draws and drops parts that would not fit, rather than using fixed column cut-offs (`de0e0b3`).

- **Width:** `e.props.bodyColumns` from the render event. It is about 5 columns narrower than the terminal (169 at a 174-column iTerm2 window).
- **Measuring:** `cols(node)` walks the element tree the render built: a wide character (emoji, East Asian) counts 2 (`WIDE`, by grapheme), a row's children are summed with their `gap`, a column is its widest child, hidden and absolutely placed boxes count 0.
- **Fitting:** `fits(...parts)`: the parts side by side, one column apart, within the width.
- **Versions:** each section lists its versions from widest to narrowest; `firstFit()` takes the first that fits beside its neighbours, else the narrowest.

| Section | Versions, widest first |
|---|---|
| top right | limits with reset times → without reset times → nothing |
| context right | session totals → nothing |
| connection | all fields → state and live wait only |
| last-prompt left | all fields → time, turn, why only |
| last-prompt right | tools → nothing (tools go before the left side loses fields) |

The top-left and context-left sections are never cut.

---

## 10. When each figure is refreshed

| Figure | Read at |
|---|---|
| clock, countdowns, live wait, session time | every second (ticker) |
| model, folder, branch, session cost, context, limits, weekly | `refreshFigures()`: session start, end of every turn (main and subagent), `/context-pane` |
| prompt count, submit time, cache `new` | `prompt.submit` |
| tool counts | each `tool.call` |
| connection stats, cache clock | each model request (`turn.step`) |
| last-prompt stats | end of the main agent's turn |
| offline state | network check, from the ticker, only during waits or outages |

---

## 11. Robustness

- **Every hook passes the event on if it fails:** `on(...).catch(passOn)`. The engine's `.catch` handler is replay-safe: if the hook had already called `next`, calling it again returns that result without running the hooks beneath twice.
- **Except `turn.step`:** replaying a stream that threw would hide the engine's own error, so it has no `.catch`; it rethrows what the stream threw.
- **`running` is cleared in a `finally`** at turn end, so a failure while gathering stats cannot leave `⚡ running` on forever.
- **Calls that may fail are guarded:** `git`, reading `statusline.state`, `refreshFigures()` and the network check each fall back to "unknown" rather than failing their hook.
- **Plugin reload:** module variables reset while atoms persist. Session start recomputes the open-request view, so a request left open by a reload does not stay "waiting".
- **Starting values:** before the first figures arrive, the render builds them from `$.session.model()`, `$.session.cwd()` and the saved weekly limit, so the bar never draws empty.

---

## 12. Cost

Measured on 2026-10-10:

- A render takes about 3 ms (average 2.8–3.1 ms, max 16 ms over 180 renders), once a second: about 0.3% of one core at most.
- The `git` call is about 5 ms, once per turn.
- Not measured: the terminal's redraw, and `$.session.usage()` per turn.
- The ticker runs even when the bar is hidden; slowing or pausing it is an open idea.

---

## 13. Constants

| Constant | Value | Meaning |
|---|---|---|
| `CELLS` | 12 | cells in the context bar |
| `TRACK` | `#6b6b6b` | empty cell color |
| `TTLS` | 5 min, 1 h | cache TTL choices |
| `SLOW_MS` | 15 s | slow request |
| `VERY_SLOW_MS` | 30 s | stalled request |
| `RECENT` | 10 | requests the average and max are taken over |
| `ERROR_SHOWN_MS` | 10 min | how long the last error stays |
| `SAME_ERROR_MS` | 10 s | a turn error this close to a request error is the same one |
| `PROBE_AFTER_MS` | 3 s | wait before the first network check |
| `PROBE_EVERY_MS` | 5 s | time between checks |
| `PROBE_TIMEOUT_MS` | 4 s | a check with no answer by then counts as offline |
| `PROBE_URL` | `https://api.anthropic.com/` | what the check fetches |
| `C` | red `#e06c75`, yellow `#e5c07b`, green `#98c379`, blue `#61afef`, cyan `#5fd7d7`, text `#abb2bf` | colors, chosen for a dark terminal |
| `TINT` | row `#2c313a`, hover `#3e4451`, picked `#4b5263` | help mode backgrounds |

---

## 14. Changing the bar

### Adding a field

1. Add an entry to `FIELDS` with its `tip` (about 60 columns at most), `label` (for help mode) and, if the tip is not enough, `doc`.
2. Add its id to the right row in `HELP`; if it belongs to a right-hand section, also to that row's `right` list.
3. Build it in the render as `{ id, node }` inside its section's field list. Use `cond && { id, node }` inside `present([...])` for a field that may be absent.
4. If it should drop out first in narrow windows, leave it out of the narrow version of its section (9).
5. Run the typecheck.

### Engine rules to keep in mind

- The engine rejects a whole render tree that has any disallowed prop or child, and draws its default instead: if the bar vanishes after a change, look for a new prop or a non-Text child of a Button.
- A Button's children may only be strings and Text.
- A hover can show or hide a box, or change its background, but cannot make a row taller.
- Panes need 110+ columns.
- `$.command.run` does not reach the calling plugin's own `command.run` hooks.
