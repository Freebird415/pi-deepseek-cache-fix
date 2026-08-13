<div align="center">

# pi-deepseek-cache

> A Pi extension for DeepSeek's prompt caching — stable prefixes, higher hit rates, real-time telemetry, and lower long-session costs.

[English](README.md) | [中文](README.zh.md)

</div>

---

A fork of [ruanbw/pi-deepseek-cache](https://github.com/ruanbw/pi-deepseek-cache) by [@ruanbw](https://github.com/ruanbw). Adds DeepSeek-only activation, a persistent average hit-rate display, and cache backfill on resume.

## Features

- **DeepSeek-only activation** — only runs for DeepSeek models (direct `deepseek` provider, or `openrouter` models with a `deepseek/` id).
- **Persistent average hit rate** — `avg cache xx.x%` shows the whole-conversation cache hit-rate across every model.
- **`cache armed` indicator** — shown when a DeepSeek model is active.
- **Hit-rate telemetry** — persists `cacheRead` / `input` / `cacheWrite` / `turns` to disk.
- **Cache backfill on resume** — restores historical stats when resuming with `pi -c`.
- **Prefix guard** — strips `volatile-scratch` messages and detects real prefix changes.
- **Cache-friendly compaction** — deterministic `deepseek-v4-flash` summaries (temperature 0), hash-cached across sessions.
- **Commands** — `/cache-stats`, `/cache-graph`, `/cache-reset`.

## Installation

### Windows

A transitive dependency ships very long filenames that exceed the Windows 260-character path limit. Run once before installing:

```bash
git config --global core.longPaths true
```

Requires [Pi](https://pi.dev) and Node.js ≥ 18.

```bash
pi install git:github.com/Freebird415/pi-deepseek-cache-fix
```

## Usage

1. Configure a DeepSeek provider (set `DEEPSEEK_API_KEY`).
2. Select a DeepSeek model such as `deepseek/deepseek-chat`.
3. The extension activates automatically; the footer shows `avg cache xx.x% · cache armed`.

## Commands

| Command | Description |
|---------|-------------|
| `/cache-stats` | Hit rate, cache hit/miss tokens, turns, estimated savings |
| `/cache-graph` | ASCII trend of the cache hit-rate |
| `/cache-reset` | Clear all stats, history, and the summary cache |

## How it works

| Layer | Description |
|-------|-------------|
| **P1 — Telemetry** | Accumulates `cacheRead` / `input` / `cacheWrite` / `turns` on `message_end`, persisted to `~/.pi/agent/extensions/deepseek-cache/` |
| **P2 — Prefix guard** | Filters `volatile-scratch` messages in the `context` hook; a SHA-256 fingerprint detects real prefix changes |
| **P3 — Compaction** | Deterministic `deepseek-v4-flash` (temperature 0) summaries, hash-cached across sessions |

## License

[MIT](./LICENSE) © Freebird415, [ruanbw](https://github.com/ruanbw)
