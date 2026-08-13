import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth, type Focusable } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// ═══════════════════════════════════════════════════════════════════════════
//  Constants
// ═══════════════════════════════════════════════════════════════════════════

const STATS_OVERLAY_WIDTH = 56;
const GRAPH_OVERLAY_WIDTH = 60;
const CHART_HEIGHT = 10;
const CHART_MAX_WIDTH = 48;
const MAX_HISTORY_POINTS = 100;
const SUMMARY_MAX_TOKENS = 8192;
const FLAT_CHART_EPSILON = 0.05;

// R12: Cost estimation — DeepSeek pricing (per million tokens, USD)
const COST_PER_MILLION_CACHE_READ = 0.027;   // cache-hit unit price
const COST_PER_MILLION_INPUT = 0.27;          // cache-miss unit price

// ───────── R9: Local type definitions, avoid any ─────────

interface CachedMessage {
  role: string;
  content?: string;
  customType?: string;
}

interface ProviderPayload {
  messages?: CachedMessage[];
}

interface PersistedStats {
  cacheRead: number;
  input: number;
  cacheWrite: number;
  turns: number;
}

interface HistoryPoint {
  turn: number;
  hitRate: number;
  timestamp: number;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Persistence
// ═══════════════════════════════════════════════════════════════════════════

const STATS_DIR = process.env.PI_DEEPSEEK_CACHE_DIR
  ?? join(homedir(), ".pi", "agent", "extensions", "deepseek-cache");
const STATS_FILE = join(STATS_DIR, "stats.json");
const HISTORY_FILE = join(STATS_DIR, "history.json");
const SUMMARY_CACHE_FILE = join(STATS_DIR, "summary-cache.json"); // R12

// Module-level ctx reference for persistence error reporting
let extensionCtx: ExtensionContext | undefined;

function loadStats(): PersistedStats {
  try {
    if (existsSync(STATS_FILE)) return JSON.parse(readFileSync(STATS_FILE, "utf-8"));
  } catch (err) {
    if (extensionCtx) {
      const msg = err instanceof Error ? err.message : String(err);
      extensionCtx.ui.notify(`[deepseek-cache] stats.json parse failed (${msg}), reset`, "warning");
    }
  }
  return { cacheRead: 0, input: 0, cacheWrite: 0, turns: 0 };
}

// R8: Async debounced writes — coalesce frequent calls, reduce sync I/O blocking
const WRITE_DEBOUNCE_MS = 1000;
let pendingStats: PersistedStats | null = null;
let statsTimer: ReturnType<typeof setTimeout> | null = null;
let pendingHistory: HistoryPoint[] | null = null;
let historyTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSaveStats(s: PersistedStats) {
  pendingStats = s;
  if (statsTimer) return;
  statsTimer = setTimeout(() => {
    statsTimer = null;
    if (!pendingStats) return;
    const data = pendingStats;
    pendingStats = null;
    (async () => {
      try {
        if (!existsSync(STATS_DIR)) mkdirSync(STATS_DIR, { recursive: true });
        await writeFile(STATS_FILE, JSON.stringify(data, null, 2));
      } catch (err) {
        if (extensionCtx) {
          const msg = err instanceof Error ? err.message : String(err);
          extensionCtx.ui.notify(`[deepseek-cache] stats.json write failed: ${msg}`, "error");
        }
      }
    })();
  }, WRITE_DEBOUNCE_MS);
}

function scheduleSaveHistory(h: HistoryPoint[]) {
  pendingHistory = h;
  if (historyTimer) return;
  historyTimer = setTimeout(() => {
    historyTimer = null;
    if (!pendingHistory) return;
    const data = pendingHistory;
    pendingHistory = null;
    (async () => {
      try {
        if (!existsSync(STATS_DIR)) mkdirSync(STATS_DIR, { recursive: true });
        await writeFile(HISTORY_FILE, JSON.stringify(data.slice(-MAX_HISTORY_POINTS), null, 2));
      } catch (err) {
        if (extensionCtx) {
          const msg = err instanceof Error ? err.message : String(err);
          extensionCtx.ui.notify(`[deepseek-cache] history.json write failed: ${msg}`, "error");
        }
      }
    })();
  }, WRITE_DEBOUNCE_MS);
}

/** R8: Force flush on session end to avoid data loss */
function flushPendingWrites() {
  if (statsTimer) {
    clearTimeout(statsTimer);
    statsTimer = null;
  }
  if (pendingStats) {
    const data = pendingStats;
    pendingStats = null;
    try {
      if (!existsSync(STATS_DIR)) mkdirSync(STATS_DIR, { recursive: true });
      writeFileSync(STATS_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
      if (extensionCtx) {
        const msg = err instanceof Error ? err.message : String(err);
        extensionCtx.ui.notify(`[deepseek-cache] stats.json flush failed: ${msg}`, "error");
      }
    }
  }
  if (historyTimer) {
    clearTimeout(historyTimer);
    historyTimer = null;
  }
  if (pendingHistory) {
    const data = pendingHistory;
    pendingHistory = null;
    try {
      if (!existsSync(STATS_DIR)) mkdirSync(STATS_DIR, { recursive: true });
      writeFileSync(HISTORY_FILE, JSON.stringify(data.slice(-MAX_HISTORY_POINTS), null, 2));
    } catch (err) {
      if (extensionCtx) {
        const msg = err instanceof Error ? err.message : String(err);
        extensionCtx.ui.notify(`[deepseek-cache] history.json flush failed: ${msg}`, "error");
      }
    }
  }
}

function loadHistory(): HistoryPoint[] {
  try {
    if (existsSync(HISTORY_FILE)) return JSON.parse(readFileSync(HISTORY_FILE, "utf-8"));
  } catch (err) {
    if (extensionCtx) {
      const msg = err instanceof Error ? err.message : String(err);
      extensionCtx.ui.notify(`[deepseek-cache] history.json parse failed (${msg}), reset`, "warning");
    }
  }
  return [];
}

// R12: Persist summary cache — reused across sessions
function loadSummaryCache(): Map<string, string> {
  try {
    if (existsSync(SUMMARY_CACHE_FILE)) {
      const data: Record<string, string> = JSON.parse(readFileSync(SUMMARY_CACHE_FILE, "utf-8"));
      return new Map(Object.entries(data));
    }
  } catch (err) {
    if (extensionCtx) {
      const msg = err instanceof Error ? err.message : String(err);
      extensionCtx.ui.notify(`[deepseek-cache] summary-cache.json parse failed (${msg}), reset`, "warning");
    }
  }
  return new Map();
}

function saveSummaryCache(cache: Map<string, string>) {
  try {
    if (!existsSync(STATS_DIR)) mkdirSync(STATS_DIR, { recursive: true });
    const obj: Record<string, string> = {};
    for (const [k, v] of cache) obj[k] = v;
    writeFileSync(SUMMARY_CACHE_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    if (extensionCtx) {
      const msg = err instanceof Error ? err.message : String(err);
      extensionCtx.ui.notify(`[deepseek-cache] summary-cache.json write failed: ${msg}`, "error");
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Overlay components
// ═══════════════════════════════════════════════════════════════════════════

/** Cache stats overlay */
class CacheStatsOverlay implements Focusable {
  readonly width = STATS_OVERLAY_WIDTH;
  focused = false;

  private stats: PersistedStats;
  private theme: Theme;
  private done: (result: unknown) => void;

  constructor(theme: Theme, stats: PersistedStats, done: (result: unknown) => void) {
    this.theme = theme;
    this.stats = stats;
    this.done = done;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "return")) {
      this.done(undefined);
    }
  }

  render(_width: number): string[] {
    const { cacheRead, input, cacheWrite, turns } = this.stats;
    const denom = cacheRead + input;
    const hitRate = denom ? ((cacheRead / denom) * 100).toFixed(1) : "0.0";
    const th = this.theme;
    const w = this.width;
    const inner = w - 2;

    // R12: Cost-savings estimate — difference between cache hit and miss
    const savedDollars = (cacheRead / 1_000_000) * (COST_PER_MILLION_INPUT - COST_PER_MILLION_CACHE_READ);
    const savedStr = savedDollars >= 0.01 ? `$${savedDollars.toFixed(2)}` : "< $0.01";

    const pad = (s: string) => s + " ".repeat(Math.max(0, inner - visibleWidth(s)));
    const row = (s: string) => th.fg("border", "│") + pad(s) + th.fg("border", "│");
    const label = (k: string, v: string) => `  ${th.fg("dim", k.padEnd(16))}${th.fg("accent", v)}`;

    return [
      th.fg("border", `╭${"─".repeat(inner)}╮`),
      row(` ${th.fg("accent", "⚡ DeepSeek Cache Stats")}`),
      row(""),
      row(label("Hit rate", `${hitRate}%`)),
      row(label("Cache hits", `${cacheRead.toLocaleString()} tokens`)),
      row(label("Cache misses", `${input.toLocaleString()} tokens`)),
      row(label("Cache writes", `${cacheWrite.toLocaleString()} tokens`)),
      row(label("Turns", `${turns}`)),
      row(label("Est. savings", `${th.fg("accent", savedStr)}`)),
      row(""),
      row(` ${th.fg("dim", "Esc to close")}`),
      th.fg("border", `╰${"─".repeat(inner)}╯`),
    ];
  }

  invalidate(): void {}
  dispose(): void {}
}

/** Cache hit-rate trend overlay */
class CacheGraphOverlay implements Focusable {
  readonly width = GRAPH_OVERLAY_WIDTH;
  focused = false;

  private history: HistoryPoint[];
  private theme: Theme;
  private done: (result: unknown) => void;

  constructor(theme: Theme, history: HistoryPoint[], done: (result: unknown) => void) {
    this.theme = theme;
    this.history = history;
    this.done = done;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "return")) {
      this.done(undefined);
    }
  }

  render(_width: number): string[] {
    const th = this.theme;
    const inner = this.width - 2;

    const pad = (s: string) => s + " ".repeat(Math.max(0, inner - visibleWidth(s)));
    const row = (s: string) => th.fg("border", "│") + pad(s) + th.fg("border", "│");

    if (this.history.length === 0) {
      return [
        th.fg("border", `╭${"─".repeat(inner)}╮`),
        row(` ${th.fg("accent", "⚡ Cache Hit-Rate Trend")}`),
        row(""),
        row(`  ${th.fg("dim", "No hit-rate data yet")}`),
        row(`  ${th.fg("dim", "Run a few turns first")}`),
        row(""),
        row(` ${th.fg("dim", "Esc to close")}`),
        th.fg("border", `╰${"─".repeat(inner)}╯`),
      ];
    }

    const rates = this.history.map((h) => h.hitRate);
    const maxRate = Math.max(...rates);
    const minRate = Math.min(...rates);
    const chartH = CHART_HEIGHT;
    const chartW = Math.min(this.history.length, CHART_MAX_WIDTH);

    // sampling
    const step = Math.max(1, Math.floor(this.history.length / chartW));
    const data = this.history.filter((_, i) => i % step === 0).slice(-chartW);

    // Y-axis label width
    const yW = Math.max(maxRate.toFixed(0).length, minRate.toFixed(0).length) + 1;

    // R6: Special handling for a flat hit rate
    const chart: string[] = [];
    if (maxRate - minRate < FLAT_CHART_EPSILON) {
      const mid = Math.floor(data.length / 2);
      const chartLine = " ".repeat(mid) + "━".repeat(1) + " ".repeat(data.length - mid - 1);
      chart.push(`${minRate.toFixed(0)}%`.padStart(yW) + chartLine);
      chart.push("".padStart(yW) + "─".repeat(data.length));
      // X-axis labels
      const first = data[0].turn;
      const last = data[data.length - 1].turn;
      const labelLine = new Array(data.length).fill(" ");
      const firstStr = String(first);
      const lastStr = String(last);
      for (let i = 0; i < firstStr.length && i < data.length; i++) labelLine[i] = firstStr[i];
      for (let i = 0; i < lastStr.length && data.length - lastStr.length + i < data.length; i++) {
        labelLine[data.length - lastStr.length + i] = lastStr[i];
      }
      chart.push("".padStart(yW) + labelLine.join(""));
    } else {
      // generate chart rows
      const chartRows: string[] = [];
      for (let r = chartH; r >= 0; r--) {
        const threshold = minRate + (maxRate - minRate) * (r / chartH);
        let line = "";
        if (r === chartH) line = `${maxRate.toFixed(0)}%`.padStart(yW);
        else if (r === 0) line = `${minRate.toFixed(0)}%`.padStart(yW);
        else line = "".padStart(yW);
        for (const p of data) {
          line += p.hitRate >= threshold ? "█" : " ";
        }
        chartRows.push(line);
      }

      // X axis
      chartRows.push("".padStart(yW) + "─".repeat(data.length));

      // R5: Fill X-axis labels into a char array at fixed positions to avoid padEnd misalignment
      const first = data[0].turn;
      const last = data[data.length - 1].turn;
      const xChars = new Array(data.length).fill(" ");

      // first label starts at position 0
      const firstStr = String(first);
      for (let i = 0; i < firstStr.length && i < data.length; i++) xChars[i] = firstStr[i];

      // middle label centered
      const mid = data.length ? String(data[Math.floor(data.length / 2)].turn) : "";
      if (mid !== "") {
        const midStr = String(mid);
        const midStart = Math.floor((data.length - midStr.length) / 2);
        for (let i = 0; i < midStr.length; i++) {
          const pos = midStart + i;
          if (pos >= 0 && pos < data.length) xChars[pos] = midStr[i];
        }
      }

      // last label right-aligned
      const lastStr = String(last);
      for (let i = 0; i < lastStr.length; i++) {
        const pos = data.length - lastStr.length + i;
        if (pos >= 0 && pos < data.length) xChars[pos] = lastStr[i];
      }

      chartRows.push("".padStart(yW) + xChars.join(""));
      chart.push(...chartRows);
    }

    // assemble the full overlay
    const lines = [
      th.fg("border", `╭${"─".repeat(inner)}╮`),
      row(` ${th.fg("accent", `⚡ Cache Hit-Rate Trend (${this.history.length} points)`)}`),
      row(""),
    ];

    for (const c of chart) {
      lines.push(row(`  ${c}`));
    }

    lines.push(row(""));
    lines.push(row(` ${th.fg("dim", "Esc to close")}`));
    lines.push(th.fg("border", `╰${"─".repeat(inner)}╯`));

    return lines;
  }

  invalidate(): void {}
  dispose(): void {}
}

// ═══════════════════════════════════════════════════════════════════════════
//  Model gating — only active for DeepSeek models (R13)
// ═══════════════════════════════════════════════════════════════════════════

interface ModelRef {
  provider?: string;
  id?: string;
}

/** True if the model is DeepSeek. Direct provider=deepseek matches;
 *  also matches openrouter models whose id starts with "deepseek/". */
function isDeepSeekModel(model: ModelRef | undefined): boolean {
  if (!model) return false;
  if (model.provider === "deepseek") return true;
  return model.provider === "openrouter" && (model.id ?? "").startsWith("deepseek/");
}

/** Whether the current session is active (a DeepSeek model is in use) */
function isActive(ctx: ExtensionContext): boolean {
  return isDeepSeekModel(ctx.model);
}

// ═══════════════════════════════════════════════════════════════════════════
//  Extension main logic
// ═══════════════════════════════════════════════════════════════════════════

export default function (pi: ExtensionAPI) {
  // Store ctx for persistence error reporting (R7)
  // Will be set on first event that provides ctx
  const setExtensionCtx = (ctx: ExtensionContext) => { extensionCtx = ctx; };

  // ───────── P1 Hit-rate telemetry (persisted) ─────────
  const persisted = loadStats();
  let { cacheRead, input, cacheWrite, turns } = persisted;
  // This-conversation average hit rate — persistent, reset on session_start,
  // not written to stats.json, independent of cross-session totals
  let sessionCacheRead = 0;
  let sessionInput = 0;
  const hitRateHistory = loadHistory();
  let lastHitRate = hitRateHistory.length > 0
    ? hitRateHistory[hitRateHistory.length - 1].hitRate
    : 0;

  /** R2: Single hit-rate calculation function */
  const calcHitRate = (r: number, i: number): number =>
    (r + i) ? (r / (r + i)) * 100 : 0;

  // ───────── Session-level persistent average hit rate ─────────
  pi.on("session_start", async (_event, ctx) => {
    setExtensionCtx(ctx);
    sessionCacheRead = 0;
    sessionInput = 0;

    // Backfill cacheRead/input from historical assistant messages — any model,
    // to compute the whole-conversation average hit rate
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (msg.role !== "assistant") continue;
      const u = msg.usage;
      if (!u) continue;
      sessionCacheRead += u.cacheRead ?? 0;
      sessionInput += u.input ?? 0;
    }

    const sessionRate = calcHitRate(sessionCacheRead, sessionInput);
    ctx.ui.setStatus("avg", `avg cache ${sessionRate.toFixed(1)}% · `);

    // On first launch / pi -c, model_select may not fire; set cache armed from the current model here
    if (ctx.model) {
      ctx.ui.setStatus("cache", isDeepSeekModel(ctx.model) ? "cache armed" : undefined);
    }
  });

  pi.on("message_end", async (event, ctx) => {
    setExtensionCtx(ctx);

    // ── Persistent avg: accumulate every assistant message regardless of model,
    //    to compute the whole-conversation average hit rate ──
    if (event.message.role === "assistant") {
      const u = event.message.usage;
      if (u) {
        sessionCacheRead += u.cacheRead ?? 0;
        sessionInput += u.input ?? 0;
        const sessionRate = calcHitRate(sessionCacheRead, sessionInput);
        ctx.ui.setStatus("avg", `avg cache ${sessionRate.toFixed(1)}% · `);
      }
    }

    // ── DeepSeek-specific: cache armed label + persisted stats (not part of avg) ──
    if (!isActive(ctx)) {
      // Non-DeepSeek model: clear the stale cache label (avg is persistent, not cleared)
      ctx.ui.setStatus("cache", undefined);
      return;
    }
    // Re-set cache armed to guard against missing model_select on first launch
    ctx.ui.setStatus("cache", "cache armed");
    if (event.message.role !== "assistant") return;
    const u = event.message.usage;
    if (!u) return;
    cacheRead += u.cacheRead ?? 0;
    input += u.input ?? 0;
    cacheWrite += u.cacheWrite ?? 0;
    turns += 1;

    scheduleSaveStats({ cacheRead, input, cacheWrite, turns });

    // R2: Compute once, reuse for status bar and history
    const rate = calcHitRate(cacheRead, input);

    // R3: Compare via toFixed(1) to avoid float dedup failures
    const rateKey = rate.toFixed(1);
    const lastKey = lastHitRate.toFixed(1);
    if (rateKey !== lastKey) {
      // R4: Truncate the in-memory array to match the persisted one
      hitRateHistory.push({ turn: turns, hitRate: rate, timestamp: Date.now() });
      if (hitRateHistory.length > MAX_HISTORY_POINTS) {
        hitRateHistory.splice(0, hitRateHistory.length - MAX_HISTORY_POINTS);
      }
      lastHitRate = rate;
      scheduleSaveHistory(hitRateHistory);
    }
  });

  // /cache-stats → overlay
  pi.registerCommand("cache-stats", {
    description: "DeepSeek prefix-cache hit rate",
    handler: async (_args, ctx) => {
      setExtensionCtx(ctx);
      if (!isActive(ctx)) {
        await ctx.ui.notify("Not a DeepSeek model — cache extension inactive", "info");
        return;
      }
      await ctx.ui.custom(
        (_tui, theme, _kb, done) =>
          new CacheStatsOverlay(theme, { cacheRead, input, cacheWrite, turns }, done),
        { overlay: true },
      );
    },
  });

  // /cache-graph → overlay
  pi.registerCommand("cache-graph", {
    description: "DeepSeek cache hit-rate trend",
    handler: async (_args, ctx) => {
      setExtensionCtx(ctx);
      if (!isActive(ctx)) {
        await ctx.ui.notify("Not a DeepSeek model — cache extension inactive", "info");
        return;
      }
      await ctx.ui.custom(
        (_tui, theme, _kb, done) =>
          new CacheGraphOverlay(theme, hitRateHistory, done),
        { overlay: true },
      );
    },
  });

  // R12: /cache-reset → clear stats and history
  pi.registerCommand("cache-reset", {
    description: "Reset DeepSeek cache stats",
    handler: async (_args, ctx) => {
      setExtensionCtx(ctx);
      if (!isActive(ctx)) {
        await ctx.ui.notify("Not a DeepSeek model — cache extension inactive", "info");
        return;
      }
      // confirmation
      await ctx.ui.notify("Cache stats reset", "info");
      cacheRead = 0;
      input = 0;
      cacheWrite = 0;
      turns = 0;
      hitRateHistory.length = 0;
      lastHitRate = 0;
      lastPrefixHash = undefined;
      lastPrefixLen = 0;
      prefixBreaks = 0;
      summaryCache.clear();
      flushPendingWrites();
      // remove persisted files
      try {
        if (existsSync(STATS_FILE)) unlinkSync(STATS_FILE);
        if (existsSync(HISTORY_FILE)) unlinkSync(HISTORY_FILE);
        if (existsSync(SUMMARY_CACHE_FILE)) unlinkSync(SUMMARY_CACHE_FILE);
      } catch {}
    },
  });

  // ───────── P2 Prefix guard ─────────
  pi.on("context", async (event, ctx) => {
    setExtensionCtx(ctx);
    if (!isActive(ctx)) return; // Non-DeepSeek: leave context untouched
    const onWire = event.messages.filter(
      (m: unknown) => (m as { customType?: string } | undefined)?.customType !== "volatile-scratch",
    );
    return { messages: onWire };
  });

  // R1: Prefix fingerprint → cache-break diagnosis
  let lastPrefixHash: string | undefined;
  let lastPrefixLen = 0;
  let prefixBreaks = 0;
  pi.on("before_provider_request", (event, ctx) => {
    setExtensionCtx(ctx);
    if (!isActive(ctx)) {
      lastPrefixHash = undefined; // Reset fingerprint to avoid false "prefix changed" when switching back to DeepSeek
      lastPrefixLen = 0;
      return;
    }
    const msgs = (event.payload as ProviderPayload).messages ?? [];

    // Correct detection: compare whether the previous request's messages are
    // byte-identical in the current request. Normal conversation growth
    // (append-only) keeps the overlap hash unchanged — no warning; only warn
    // when existing messages are modified/removed (or compaction rewrites history).
    if (lastPrefixHash !== undefined) {
      const overlap = msgs.slice(0, lastPrefixLen);
      const overlapHash = createHash("sha256")
        .update(JSON.stringify(overlap)).digest("hex");
      if (overlapHash !== lastPrefixHash) {
        prefixBreaks++;
        ctx.ui.notify(
          `Cache prefix changed (${prefixBreaks}), this turn may miss the cache`,
          "warning",
        );
      }
    }
    lastPrefixHash = createHash("sha256")
      .update(JSON.stringify(msgs)).digest("hex");
    lastPrefixLen = msgs.length;
  });

  // ───────── Model switch: clean up state when leaving DeepSeek ─────────
  pi.on("model_select", (event, ctx) => {
    setExtensionCtx(ctx);
    if (isDeepSeekModel(event.model)) {
      ctx.ui.setStatus("cache", "cache armed");
    } else {
      ctx.ui.setStatus("cache", undefined);
      lastPrefixHash = undefined;
    }
  });

  // ───────── P3 Cache-friendly compaction ─────────
  const summaryCache = loadSummaryCache(); // R12: Load summary cache from disk, reused across sessions
  pi.on("session_before_compact", async (event, ctx) => {
    setExtensionCtx(ctx);
    if (!isActive(ctx)) return; // Non-DeepSeek: use pi's default compaction
    flushPendingWrites(); // R8: Force flush before compaction to avoid losing unwritten data
    const { preparation, signal } = event;
    const { messagesToSummarize, firstKeptEntryId, tokensBefore, previousSummary } = preparation;

    const history = serializeConversation(convertToLlm(messagesToSummarize));
    const text = previousSummary
      ? `[Previous summary]\n${previousSummary}\n\n[New history]\n${history}`
      : history;

    const key = createHash("sha256").update(text).digest("hex");
    let summary = summaryCache.get(key);
    if (!summary) {
      summary = await summarizeWithFlash(text, ctx, signal);
      if (!summary) return;
      summaryCache.set(key, summary);
      saveSummaryCache(summaryCache); // R12: Persist the new summary, reused across sessions
    }

    return {
      compaction: {
        summary,
        firstKeptEntryId,
        tokensBefore,
        details: { summarizer: "deepseek-v4-flash" },
      },
    };
  });
}

async function summarizeWithFlash(
  text: string,
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<string | undefined> {
  const model = ctx.modelRegistry.find("deepseek", "deepseek-v4-flash");
  if (!model) {
    ctx.ui.notify("deepseek-v4-flash not found, falling back to default compaction", "warning");
    return;
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    ctx.ui.notify("flash summarizer auth failed, falling back to default compaction", "warning");
    return;
  }

  try {
    const response = await complete(
      model,
      {
        messages: [
          {
            role: "user" as const,
            content: [
              {
                type: "text" as const,
                text:
                  "Compress the following conversation history into a structured markdown summary, covering: " +
                  "① goals ② key decisions and rationale ③ code/file changes ④ current progress ⑤ blockers and open issues ⑥ next steps. " +
                  "Be complete, as it will replace this history.\n\n" +
                  text,
              },
            ],
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey: auth.apiKey, headers: auth.headers, maxTokens: SUMMARY_MAX_TOKENS, signal, temperature: 0 },
    );

    const summary = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    return summary.trim() || undefined;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`flash summarizer failed: ${msg}, falling back to default compaction`, "error");
    return;
  }
}
