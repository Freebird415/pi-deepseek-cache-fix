import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function clearPersistedData() {
  const dir = process.env.PI_DEEPSEEK_CACHE_DIR
    ?? join(homedir(), ".pi", "agent", "extensions", "deepseek-cache");
  ["stats.json", "history.json", "summary-cache.json"].forEach((f) => {
    const p = join(dir, f);
    if (existsSync(p)) unlinkSync(p);
  });
}

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-ai")>();
  return { ...actual, complete: vi.fn() };
});

const { complete } = await import("@earendil-works/pi-ai");
import index from "../index.js";

function createMockExtensionAPI() {
  const listeners = new Map<string, Function[]>();
  const commands = new Map<string, { description: string; handler: Function }>();
  return {
    on: vi.fn((event: string, listener: Function) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(listener);
    }),
    registerCommand: vi.fn((name: string, cmd: any) => { commands.set(name, cmd); }),
    __emit: async (event: string, data: any, ctxOverride?: unknown) => {
      for (const fn of listeners.get(event) ?? []) await fn(data, ctxOverride ?? mockCtx);
    },
    __getListener: (event: string) => listeners.get(event)?.[0] ?? null,
    __getCommand: (name: string) => commands.get(name),
  };
}

const mockCtx = {
  model: { provider: "deepseek", id: "deepseek-chat" },
  ui: {
    setStatus: vi.fn(),
    notify: vi.fn(),
    custom: vi.fn().mockResolvedValue(undefined),
  },
  modelRegistry: { find: vi.fn(), getApiKeyAndHeaders: vi.fn() },
  // Default empty history; tests replace mockCtx.sessionManager as needed
  sessionManager: { getEntries: vi.fn(() => []) },
};

// ═══ P1: Hit-rate telemetry ═══
describe("P1: cache hit telemetry", () => {
  let api: ReturnType<typeof createMockExtensionAPI>;
  beforeEach(() => { clearPersistedData(); api = createMockExtensionAPI(); index(api as any); });

  it("accumulates cacheRead / input / cacheWrite / turns", async () => {
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 100, input: 50, cacheWrite: 10 } } });
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 200, input: 30, cacheWrite: 5 } } });
    await api.__getCommand("cache-stats")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });

  it("ignores non-assistant messages", async () => {
    await api.__emit("message_end", { message: { role: "user", usage: { cacheRead: 999, input: 999, cacheWrite: 999 } } });
    await api.__getCommand("cache-stats")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });

  it("does not crash without usage", async () => {
    await api.__emit("message_end", { message: { role: "assistant" } });
    await api.__getCommand("cache-stats")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });

  it("does not divide by zero when cacheRead/denom=0", async () => {
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 0, input: 0, cacheWrite: 0 } } });
    await api.__getCommand("cache-stats")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });
});

// ═══ P1a: cache-graph command ═══
describe("P1a: cache-graph command", () => {
  let api: ReturnType<typeof createMockExtensionAPI>;
  beforeEach(() => { clearPersistedData(); api = createMockExtensionAPI(); index(api as any); });

  it("shows a hint when there is no history", async () => {
    await api.__getCommand("cache-graph")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });

  it("renders the chart when data exists", async () => {
    for (const [cr, inp] of [[0,100],[50,50],[80,20],[90,10],[95,5]]) {
      await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: cr, input: inp, cacheWrite: 0 } } });
    }
    await api.__getCommand("cache-graph")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });

  it("does not record duplicate equal hit rates", async () => {
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 10, input: 10, cacheWrite: 0 } } });
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 20, input: 20, cacheWrite: 0 } } });
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 30, input: 30, cacheWrite: 0 } } });
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 80, input: 20, cacheWrite: 0 } } });
    await api.__getCommand("cache-graph")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });

  it("chart includes X-axis turn numbers", async () => {
    for (const [cr, inp] of [[0,100],[50,50],[80,20],[90,10],[95,5]]) {
      await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: cr, input: inp, cacheWrite: 0 } } });
    }
    await api.__getCommand("cache-graph")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });

  // Render helper: invoke the ui.custom callback to get the overlay, then call render
  const fakeTheme = { fg: (_k: string, s: string) => s };
  const renderGraph = async () => {
    await api.__getCommand("cache-graph")!.handler([], mockCtx);
    const cb = mockCtx.ui.custom.mock.calls[0][0];
    const overlay = cb(null, fakeTheme, null, () => {});
    return overlay.render(60);
  };

  it("renders the chart when the hit rate varies", async () => {
    for (const [cr, inp] of [[0,100],[50,50],[80,20],[90,10],[95,5]]) {
      await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: cr, input: inp, cacheWrite: 0 } } });
    }
    const lines = await renderGraph();
    expect(lines.length).toBeGreaterThan(3);
  });

  it("renders the chart when the hit rate is flat (fix undeclared chart bug)", async () => {
    for (let i = 0; i < 5; i++) {
      await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 50, input: 50, cacheWrite: 0 } } });
    }
    const lines = await renderGraph();
    expect(lines.length).toBeGreaterThan(3);
  });
});

// ═══ P2: Prefix guard ═══
describe("P2: volatile-scratch stripping", () => {
  let api: ReturnType<typeof createMockExtensionAPI>;
  beforeEach(() => { clearPersistedData(); api = createMockExtensionAPI(); index(api as any); });

  it("filters out customType=volatile-scratch messages", async () => {
    const messages = [
      { role: "system", content: "keep" },
      { role: "user", customType: "volatile-scratch", content: "scratch" },
      { role: "assistant", content: "keep" },
      { role: "user", customType: "volatile-scratch", content: "scratch2" },
    ];
    const ctx = (api.on as any).mock.calls.find(([e]: [string]) => e === "context")?.[1];
    expect((await ctx({ messages }, mockCtx)).messages).toEqual([{ role: "system", content: "keep" }, { role: "assistant", content: "keep" }]);
  });

  it("keeps all messages when no volatile-scratch", async () => {
    const messages = [{ role: "system", content: "a" }, { role: "user", content: "b" }];
    const ctx = (api.on as any).mock.calls.find(([e]: [string]) => e === "context")?.[1];
    expect((await ctx({ messages }, mockCtx)).messages).toEqual(messages);
  });

  it("does not filter when customType is undefined", async () => {
    const messages = [{ role: "user", content: "normal" }];
    const ctx = (api.on as any).mock.calls.find(([e]: [string]) => e === "context")?.[1];
    expect((await ctx({ messages }, mockCtx)).messages).toEqual(messages);
  });

  it("before_provider_request records the prefix hash", async () => {
    const ctx = (api.on as any).mock.calls.find(([e]: [string]) => e === "before_provider_request")?.[1];
    expect(ctx).toBeDefined();
    ctx({ payload: { messages: [{ role: "system", content: "a" }, { role: "user", content: "b" }] } }, mockCtx);
  });

  it("does not false-alarm on normal conversation growth", async () => {
    const listener = api.__getListener("before_provider_request");
    // request 1 (first, establishes baseline)
    listener({ payload: { messages: [{ role: "system", content: "s" }, { role: "user", content: "u1" }] } }, mockCtx);
    // request 2: append assistant + toolResult (normal growth)
    listener({ payload: { messages: [{ role: "system", content: "s" }, { role: "user", content: "u1" }, { role: "assistant", content: "a1" }, { role: "toolResult", toolName: "bash" }] } }, mockCtx);
    // request 3: keep appending
    listener({ payload: { messages: [{ role: "system", content: "s" }, { role: "user", content: "u1" }, { role: "assistant", content: "a1" }, { role: "toolResult", toolName: "bash" }, { role: "assistant", content: "a2" }] } }, mockCtx);
    expect(mockCtx.ui.notify).not.toHaveBeenCalled();
  });

  it("alerts when an existing message is modified", async () => {
    const listener = api.__getListener("before_provider_request");
    listener({ payload: { messages: [{ role: "system", content: "s" }, { role: "user", content: "u1" }] } }, mockCtx);
    // user message content changed (prefix broken)
    listener({ payload: { messages: [{ role: "system", content: "s" }, { role: "user", content: "u1-CHANGED" }, { role: "assistant", content: "a1" }] } }, mockCtx);
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("prefix changed"), "warning");
  });

  it("alerts when messages are removed (length shrinks)", async () => {
    const listener = api.__getListener("before_provider_request");
    listener({ payload: { messages: [{ role: "system", content: "s" }, { role: "user", content: "u1" }, { role: "assistant", content: "a1" }] } }, mockCtx);
    // shrunk (e.g. compaction rewrites history)
    listener({ payload: { messages: [{ role: "system", content: "summary" }, { role: "user", content: "u2" }] } }, mockCtx);
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("prefix changed"), "warning");
  });
});

// ═══ P3: session_before_compact ═══
describe("P3: session_before_compact", () => {
  let api: ReturnType<typeof createMockExtensionAPI>;
  beforeEach(() => {
    clearPersistedData(); api = createMockExtensionAPI();
    mockCtx.modelRegistry.find.mockReturnValue({ id: "deepseek-v4-flash", provider: "deepseek" });
    mockCtx.modelRegistry.getApiKeyAndHeaders.mockResolvedValue({ ok: true, apiKey: "sk-test", headers: {} });
    vi.mocked(complete).mockReset();
    index(api as any);
  });

  it("hits the summary cache for identical input", async () => {
    const listener = (api.on as any).mock.calls.find(([e]: [string]) => e === "session_before_compact")?.[1];
    const prep = { messagesToSummarize: [{ role: "user", content: "hello" }], firstKeptEntryId: "e1", tokensBefore: 1000, previousSummary: "" };
    vi.mocked(complete).mockResolvedValueOnce({ content: [{ type: "text", text: "summary A" }] } as any);
    expect((await listener({ preparation: prep, signal: new AbortController().signal }, mockCtx)).compaction.summary).toBe("summary A");
    vi.mocked(complete).mockClear();
    expect((await listener({ preparation: prep, signal: new AbortController().signal }, mockCtx)).compaction.summary).toBe("summary A");
    expect(complete).not.toHaveBeenCalled();
  });

  it("falls back when the model is missing", async () => {
    mockCtx.modelRegistry.find.mockReturnValue(null);
    const listener = (api.on as any).mock.calls.find(([e]: [string]) => e === "session_before_compact")?.[1];
    expect(await listener({ preparation: { messagesToSummarize: [], firstKeptEntryId: "e1", tokensBefore: 500, previousSummary: "" }, signal: new AbortController().signal }, mockCtx)).toBeUndefined();
  });

  it("includes previousSummary in the hash input", async () => {
    const listener = (api.on as any).mock.calls.find(([e]: [string]) => e === "session_before_compact")?.[1];
    vi.mocked(complete).mockResolvedValueOnce({ content: [{ type: "text", text: "summary v1" }] } as any);
    const r1 = await listener({ preparation: { messagesToSummarize: [{ role: "user", content: "same" }], firstKeptEntryId: "e1", tokensBefore: 100, previousSummary: "v1" }, signal: new AbortController().signal }, mockCtx);
    vi.mocked(complete).mockResolvedValueOnce({ content: [{ type: "text", text: "summary v2" }] } as any);
    const r2 = await listener({ preparation: { messagesToSummarize: [{ role: "user", content: "same" }], firstKeptEntryId: "e1", tokensBefore: 100, previousSummary: "v2" }, signal: new AbortController().signal }, mockCtx);
    expect(r1.compaction.summary).toBe("summary v1");
    expect(r2.compaction.summary).toBe("summary v2");
  });

  it("falls back on auth failure", async () => {
    mockCtx.modelRegistry.getApiKeyAndHeaders.mockResolvedValueOnce({ ok: false, apiKey: undefined, headers: {} });
    const listener = (api.on as any).mock.calls.find(([e]: [string]) => e === "session_before_compact")?.[1];
    expect(await listener({ preparation: { messagesToSummarize: [], firstKeptEntryId: "e1", tokensBefore: 500, previousSummary: "" }, signal: new AbortController().signal }, mockCtx)).toBeUndefined();
  });

  it("falls back when complete fails", async () => {
    vi.mocked(complete).mockRejectedValueOnce(new Error("API error"));
    const listener = (api.on as any).mock.calls.find(([e]: [string]) => e === "session_before_compact")?.[1];
    expect(await listener({ preparation: { messagesToSummarize: [{ role: "user", content: "test" }], firstKeptEntryId: "e1", tokensBefore: 500, previousSummary: "" }, signal: new AbortController().signal }, mockCtx)).toBeUndefined();
  });

  it("falls back on empty summary", async () => {
    vi.mocked(complete).mockResolvedValueOnce({ content: [{ type: "text", text: "   " }] } as any);
    const listener = (api.on as any).mock.calls.find(([e]: [string]) => e === "session_before_compact")?.[1];
    expect(await listener({ preparation: { messagesToSummarize: [], firstKeptEntryId: "e1", tokensBefore: 500, previousSummary: "" }, signal: new AbortController().signal }, mockCtx)).toBeUndefined();
  });
});

// ═══ R13: Model gating — DeepSeek only ═══
describe("Model gating: DeepSeek only", () => {
  let api: ReturnType<typeof createMockExtensionAPI>;
  const claudeCtx = { ...mockCtx, model: { provider: "anthropic", id: "claude-sonnet-4-5" } };

  beforeEach(() => {
    clearPersistedData();
    // clear shared mock call history to avoid cross-test pollution
    mockCtx.ui.setStatus.mockClear();
    mockCtx.ui.notify.mockClear();
    mockCtx.ui.custom.mockClear();
    vi.mocked(complete).mockClear();
    api = createMockExtensionAPI();
    index(api as any);
  });

  it("accumulates telemetry and shows avg hit rate for direct DeepSeek", async () => {
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 100, input: 50, cacheWrite: 10 } } });
    // 100 / (100+50) = 66.7%
    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("avg", "avg cache 66.7% · ");
  });

  it("activates for OpenRouter deepseek/ models", async () => {
    const orCtx = { ...mockCtx, model: { provider: "openrouter", id: "deepseek/deepseek-chat" } };
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 100, input: 50, cacheWrite: 10 } } }, orCtx);
    expect(orCtx.ui.setStatus).toHaveBeenCalledWith("avg", "avg cache 66.7% · ");
  });

  it("does not accumulate telemetry and clears the status bar for non-DeepSeek", async () => {
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 100, input: 50, cacheWrite: 10 } } }, claudeCtx);
    expect(claudeCtx.ui.setStatus).toHaveBeenCalledWith("cache", undefined);
    // no accumulation → /cache-stats shows "inactive", no overlay
    await api.__getCommand("cache-stats")!.handler([], claudeCtx);
    expect(claudeCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("inactive"), "info");
    expect(claudeCtx.ui.custom).not.toHaveBeenCalled();
  });

  it("does not filter volatile-scratch in context for non-DeepSeek", async () => {
    const messages = [
      { role: "system", content: "keep" },
      { role: "user", customType: "volatile-scratch", content: "scratch" },
    ];
    const ctx = api.__getListener("context");
    expect(await ctx({ messages }, claudeCtx)).toBeUndefined();
  });

  it("does not warn in before_provider_request for non-DeepSeek", async () => {
    const listener = api.__getListener("before_provider_request");
    listener({ payload: { messages: [{ role: "user", content: "a" }] } }, claudeCtx);
    listener({ payload: { messages: [{ role: "user", content: "b" }] } }, claudeCtx);
    expect(claudeCtx.ui.notify).not.toHaveBeenCalled();
  });

  it("falls back to default compaction for non-DeepSeek (no flash)", async () => {
    mockCtx.modelRegistry.find.mockReturnValue({ id: "deepseek-v4-flash", provider: "deepseek" });
    mockCtx.modelRegistry.getApiKeyAndHeaders.mockResolvedValue({ ok: true, apiKey: "sk-test", headers: {} });
    const listener = api.__getListener("session_before_compact");
    const result = await listener(
      { preparation: { messagesToSummarize: [{ role: "user", content: "hello" }], firstKeptEntryId: "e1", tokensBefore: 1000, previousSummary: "" }, signal: new AbortController().signal },
      claudeCtx,
    );
    expect(result).toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
  });

  it("clears the status bar when model_select switches to non-DeepSeek", async () => {
    await api.__emit("model_select", { model: { provider: "anthropic", id: "claude-sonnet-4-5" } });
    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("cache", undefined);
  });

  it("shows armed when model_select switches to DeepSeek", async () => {
    await api.__emit("model_select", { model: { provider: "deepseek", id: "deepseek-chat" } });
    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("cache", "cache armed");
  });

  // ───────── Persistent avg hit rate ─────────
  it("initializes avg to 0.0% on session_start", async () => {
    await api.__emit("session_start", { reason: "new" });
    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("avg", "avg cache 0.0% · ");
  });

  it("sets cache armed from the current model on session_start (model_select may not fire)", async () => {
    // mockCtx.model is deepseek by default
    await api.__emit("session_start", { reason: "resume" });
    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("cache", "cache armed");
  });

  it("clears the cache label on session_start for non-DeepSeek", async () => {
    await api.__emit("session_start", { reason: "new" }, claudeCtx);
    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("cache", undefined);
  });

  it("updates avg after a DeepSeek message", async () => {
    await api.__emit("session_start", { reason: "new" });
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 80, input: 20, cacheWrite: 0 } } });
    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("avg", "avg cache 80.0% · ");
    // another one
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 90, input: 10, cacheWrite: 0 } } });
    // (80+90)/(80+90+20+10) = 170/200 = 85.0%
    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("avg", "avg cache 85.0% · ");
  });

  it("keeps avg after switching to non-DeepSeek (persistent)", async () => {
    await api.__emit("session_start", { reason: "new" });
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 80, input: 20, cacheWrite: 0 } } });
    mockCtx.ui.setStatus.mockClear();
    // after switching to non-DeepSeek, avg must not be cleared
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 999, input: 999, cacheWrite: 999 } } }, claudeCtx);
    expect(mockCtx.ui.setStatus).not.toHaveBeenCalledWith("avg", undefined);
  });

  it("backfills historical assistant messages on session_start (any model)", async () => {
    // simulate a pi -c resumed session: assistant messages from all models are counted
    mockCtx.sessionManager.getEntries.mockReturnValueOnce([
      { type: "message", message: { role: "user", content: "hi" } },
      { type: "message", message: { role: "assistant", provider: "deepseek", model: "deepseek-chat", usage: { cacheRead: 80, input: 20, cacheWrite: 0 } } },
      { type: "message", message: { role: "toolResult", toolName: "bash" } },
      { type: "message", message: { role: "assistant", provider: "deepseek", model: "deepseek-chat", usage: { cacheRead: 90, input: 10, cacheWrite: 0 } } },
      // non-DeepSeek (e.g. Claude) with cacheRead is also counted
      { type: "message", message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4-5", usage: { cacheRead: 60, input: 40, cacheWrite: 0 } } },
      { type: "message", message: { role: "assistant", provider: "deepseek", model: "deepseek-chat", usage: { cacheRead: 100, input: 0, cacheWrite: 0 } } },
    ] as any);
    await api.__emit("session_start", { reason: "resume" });
    // cacheRead: 80+90+60+100 = 330, input: 20+10+40+0 = 70 → 330/400 = 82.5%
    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("avg", "avg cache 82.5% · ");
  });

  it("backfill also supports OpenRouter deepseek/", async () => {
    mockCtx.sessionManager.getEntries.mockReturnValueOnce([
      { type: "message", message: { role: "assistant", provider: "openrouter", model: "deepseek/deepseek-chat", usage: { cacheRead: 95, input: 5, cacheWrite: 0 } } },
    ] as any);
    await api.__emit("session_start", { reason: "new" });
    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("avg", "avg cache 95.0% · ");
  });

  it("backfills on reload (avg is not lost)", async () => {
    mockCtx.sessionManager.getEntries.mockReturnValueOnce([
      { type: "message", message: { role: "assistant", provider: "deepseek", model: "deepseek-chat", usage: { cacheRead: 80, input: 20, cacheWrite: 0 } } },
    ] as any);
    await api.__emit("session_start", { reason: "reload" });
    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("avg", "avg cache 80.0% · ");
  });

  it("non-DeepSeek messages also update avg", async () => {
    await api.__emit("session_start", { reason: "new" });
    // Claude message: cacheRead 100 / input 100 → 50%
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 100, input: 100, cacheWrite: 0 } } }, claudeCtx);
    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("avg", "avg cache 50.0% · ");
    // and the cache label is cleared (non-DeepSeek)
    expect(claudeCtx.ui.setStatus).toHaveBeenCalledWith("cache", undefined);
  });

  it("mixed-model messages: avg accumulates cacheRead/input from all models", async () => {
    await api.__emit("session_start", { reason: "new" });
    // DeepSeek message
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 80, input: 20, cacheWrite: 0 } } });
    // Claude message
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 10, input: 90, cacheWrite: 0 } } }, claudeCtx);
    // (80+10)/(80+20+10+90) = 90/200 = 45.0%
    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("avg", "avg cache 45.0% · ");
  });
});
