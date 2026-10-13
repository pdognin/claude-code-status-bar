# status-bar

A Claude Code mod that draws a band above the prompt: context fill, session and weekly cost, rate limits, model, git branch, connection health and per-prompt stats (time, tokens, speed, cache). Hover tips explain each part, and `/bar-help` lists them in full.

## Try it

```
claude --plugin-dir ./status-bar
```

## Typecheck

```
npx tsc -p tsconfig.json
```

The engine typings in `.claude-plugin/types/` are generated and not committed.
