# pi-deepseek-cache

> Fork of [ruanbw/pi-deepseek-cache](https://github.com/ruanbw/pi-deepseek-cache), created by [@ruanbw](https://github.com/ruanbw).
> Adds DeepSeek-only activation, a persistent average-hit-rate display, and cache backfill on resume.

A [Pi](https://pi.dev) extension that gets the most out of DeepSeek's prompt caching: stable prompt prefixes, higher cache-hit rates, and real-time telemetry — cutting long-session costs by ~90%.

## Features

- **DeepSeek-only activation** — the extension only runs for DeepSeek models (direct `deepseek` provider, or `openrouter` models with a `deepseek/` id). All other models are left untouched.
- **Persistent average hit rate** — an `avg cache xx.x%` status always shows the whole conversation's cache-hit rate across every model.
- **`cache armed` indicator** — shown whenever a DeepSeek model is active.
- **Hit-rate telemetry** — accumulates `cacheRead` / `input` / `cacheWrite` / `turns` and persists them to disk.
- **Cache backfill on resume** — restores historical cache stats when resuming a session with `pi -c`.
- **Prefix guard** — strips `volatile-scratch` messages and detects real prefix changes (not normal conversation growth).
- **Cache-friendly compaction** — deterministic `deepseek-v4-flash` summaries (temperature 0), hash-cached across sessions.
- **Commands** — `/cache-stats`, `/cache-graph`, `/cache-reset`.

## Installation

Requires [Pi](https://pi.dev) and Node.js ≥ 18.

```bash
pi install git:github.com/Freebird415/pi-deepseek-cache-fix
```

### Windows

Run once before installing. A transitive dependency ships very long filenames that exceed the Windows 260-character path limit, causing `git clean` to fail with "Filename too long":

```bash
git config --global core.longPaths true
```

## Usage

1. Configure a DeepSeek provider (set `DEEPSEEK_API_KEY`).
2. Select a DeepSeek model such as `deepseek/deepseek-chat`.
3. The extension activates automatically; the footer shows `avg cache xx.x% · cache armed`.

## Commands

| Command | Description |
|---------|-------------|
| `/cache-stats` | Hit rate, cache hit/miss tokens, turns, and estimated savings |
| `/cache-graph` | ASCII trend of the cache-hit rate |
| `/cache-reset` | Clear all stats, history, and the summary cache |

## How it works

| Layer | Description |
|-------|-------------|
| **P1 — Telemetry** | Accumulates `cacheRead` / `input` / `cacheWrite` / `turns` on `message_end`, persisted to `~/.pi/agent/extensions/deepseek-cache/` |
| **P2 — Prefix guard** | Filters `volatile-scratch` messages in the `context` hook; a SHA-256 fingerprint detects real prefix changes |
| **P3 — Compaction** | Deterministic `deepseek-v4-flash` (temperature 0) summaries, cached by SHA-256 across sessions |

## License

[MIT](./LICENSE) © Freebird415, [ruanbw](https://github.com/ruanbw)
