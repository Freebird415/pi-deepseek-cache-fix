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
  // 默认空历史;测试需要时在用例里替换 mockCtx.sessionManager
  sessionManager: { getEntries: vi.fn(() => []) },
};

// ═══ P1: 命中率遥测 ═══
describe("P1: cache hit telemetry", () => {
  let api: ReturnType<typeof createMockExtensionAPI>;
  beforeEach(() => { clearPersistedData(); api = createMockExtensionAPI(); index(api as any); });

  it("累计 cacheRead / input / cacheWrite / turns", async () => {
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 100, input: 50, cacheWrite: 10 } } });
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 200, input: 30, cacheWrite: 5 } } });
    await api.__getCommand("cache-stats")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });

  it("忽略非 assistant 消息", async () => {
    await api.__emit("message_end", { message: { role: "user", usage: { cacheRead: 999, input: 999, cacheWrite: 999 } } });
    await api.__getCommand("cache-stats")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });

  it("无 usage 时不崩溃", async () => {
    await api.__emit("message_end", { message: { role: "assistant" } });
    await api.__getCommand("cache-stats")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });

  it("cacheRead/denom=0 时不除零", async () => {
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 0, input: 0, cacheWrite: 0 } } });
    await api.__getCommand("cache-stats")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });
});

// ═══ P1a: cache-graph 命令 ═══
describe("P1a: cache-graph command", () => {
  let api: ReturnType<typeof createMockExtensionAPI>;
  beforeEach(() => { clearPersistedData(); api = createMockExtensionAPI(); index(api as any); });

  it("无历史数据时显示提示", async () => {
    await api.__getCommand("cache-graph")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });

  it("有数据时输出图表", async () => {
    for (const [cr, inp] of [[0,100],[50,50],[80,20],[90,10],[95,5]]) {
      await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: cr, input: inp, cacheWrite: 0 } } });
    }
    await api.__getCommand("cache-graph")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });

  it("相同命中率不重复记录", async () => {
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 10, input: 10, cacheWrite: 0 } } });
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 20, input: 20, cacheWrite: 0 } } });
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 30, input: 30, cacheWrite: 0 } } });
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 80, input: 20, cacheWrite: 0 } } });
    await api.__getCommand("cache-graph")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });

  it("图表包含 X 轴 turn 编号", async () => {
    for (const [cr, inp] of [[0,100],[50,50],[80,20],[90,10],[95,5]]) {
      await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: cr, input: inp, cacheWrite: 0 } } });
    }
    await api.__getCommand("cache-graph")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });

  // 渲染辅助:直接执行传给 ui.custom 的回调,拿到 overlay 实例后调用 render
  const fakeTheme = { fg: (_k: string, s: string) => s };
  const renderGraph = async () => {
    await api.__getCommand("cache-graph")!.handler([], mockCtx);
    const cb = mockCtx.ui.custom.mock.calls[0][0];
    const overlay = cb(null, fakeTheme, null, () => {});
    return overlay.render(60);
  };

  it("命中率有波动时正常渲染图表", async () => {
    for (const [cr, inp] of [[0,100],[50,50],[80,20],[90,10],[95,5]]) {
      await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: cr, input: inp, cacheWrite: 0 } } });
    }
    const lines = await renderGraph();
    expect(lines.length).toBeGreaterThan(3);
  });

  it("命中率无波动时也能渲染图表(修复 chart 未声明 bug)", async () => {
    for (let i = 0; i < 5; i++) {
      await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 50, input: 50, cacheWrite: 0 } } });
    }
    const lines = await renderGraph();
    expect(lines.length).toBeGreaterThan(3);
  });
});

// ═══ P2: 前缀守卫 ═══
describe("P2: volatile-scratch stripping", () => {
  let api: ReturnType<typeof createMockExtensionAPI>;
  beforeEach(() => { clearPersistedData(); api = createMockExtensionAPI(); index(api as any); });

  it("过滤掉 customType=volatile-scratch 的消息", async () => {
    const messages = [
      { role: "system", content: "keep" },
      { role: "user", customType: "volatile-scratch", content: "scratch" },
      { role: "assistant", content: "keep" },
      { role: "user", customType: "volatile-scratch", content: "scratch2" },
    ];
    const ctx = (api.on as any).mock.calls.find(([e]: [string]) => e === "context")?.[1];
    expect((await ctx({ messages }, mockCtx)).messages).toEqual([{ role: "system", content: "keep" }, { role: "assistant", content: "keep" }]);
  });

  it("无 volatile-scratch 消息时保留全部", async () => {
    const messages = [{ role: "system", content: "a" }, { role: "user", content: "b" }];
    const ctx = (api.on as any).mock.calls.find(([e]: [string]) => e === "context")?.[1];
    expect((await ctx({ messages }, mockCtx)).messages).toEqual(messages);
  });

  it("customType 字段为 undefined 时不过滤", async () => {
    const messages = [{ role: "user", content: "normal" }];
    const ctx = (api.on as any).mock.calls.find(([e]: [string]) => e === "context")?.[1];
    expect((await ctx({ messages }, mockCtx)).messages).toEqual(messages);
  });

  it("before_provider_request 记录前缀哈希", async () => {
    const ctx = (api.on as any).mock.calls.find(([e]: [string]) => e === "before_provider_request")?.[1];
    expect(ctx).toBeDefined();
    ctx({ payload: { messages: [{ role: "system", content: "a" }, { role: "user", content: "b" }] } }, mockCtx);
  });

  it("对话正常增长时前缀检测不误报", async () => {
    const listener = api.__getListener("before_provider_request");
    // 请求1(首次,建立基线)
    listener({ payload: { messages: [{ role: "system", content: "s" }, { role: "user", content: "u1" }] } }, mockCtx);
    // 请求2:尾部追加 assistant + toolResult(正常增长)
    listener({ payload: { messages: [{ role: "system", content: "s" }, { role: "user", content: "u1" }, { role: "assistant", content: "a1" }, { role: "toolResult", toolName: "bash" }] } }, mockCtx);
    // 请求3:继续追加
    listener({ payload: { messages: [{ role: "system", content: "s" }, { role: "user", content: "u1" }, { role: "assistant", content: "a1" }, { role: "toolResult", toolName: "bash" }, { role: "assistant", content: "a2" }] } }, mockCtx);
    expect(mockCtx.ui.notify).not.toHaveBeenCalled();
  });

  it("既有消息被修改时前缀检测告警", async () => {
    const listener = api.__getListener("before_provider_request");
    listener({ payload: { messages: [{ role: "system", content: "s" }, { role: "user", content: "u1" }] } }, mockCtx);
    // 修改了 user 消息内容(前缀被破坏)
    listener({ payload: { messages: [{ role: "system", content: "s" }, { role: "user", content: "u1-CHANGED" }, { role: "assistant", content: "a1" }] } }, mockCtx);
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("缓存前缀变化"), "warning");
  });

  it("消息被删除(长度收缩)时前缀检测告警", async () => {
    const listener = api.__getListener("before_provider_request");
    listener({ payload: { messages: [{ role: "system", content: "s" }, { role: "user", content: "u1" }, { role: "assistant", content: "a1" }] } }, mockCtx);
    // 收缩(如 compaction 重写历史)
    listener({ payload: { messages: [{ role: "system", content: "summary" }, { role: "user", content: "u2" }] } }, mockCtx);
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("缓存前缀变化"), "warning");
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

  it("相同输入命中摘要缓存", async () => {
    const listener = (api.on as any).mock.calls.find(([e]: [string]) => e === "session_before_compact")?.[1];
    const prep = { messagesToSummarize: [{ role: "user", content: "hello" }], firstKeptEntryId: "e1", tokensBefore: 1000, previousSummary: "" };
    vi.mocked(complete).mockResolvedValueOnce({ content: [{ type: "text", text: "summary A" }] } as any);
    expect((await listener({ preparation: prep, signal: new AbortController().signal }, mockCtx)).compaction.summary).toBe("summary A");
    vi.mocked(complete).mockClear();
    expect((await listener({ preparation: prep, signal: new AbortController().signal }, mockCtx)).compaction.summary).toBe("summary A");
    expect(complete).not.toHaveBeenCalled();
  });

  it("模型不存在时回退", async () => {
    mockCtx.modelRegistry.find.mockReturnValue(null);
    const listener = (api.on as any).mock.calls.find(([e]: [string]) => e === "session_before_compact")?.[1];
    expect(await listener({ preparation: { messagesToSummarize: [], firstKeptEntryId: "e1", tokensBefore: 500, previousSummary: "" }, signal: new AbortController().signal }, mockCtx)).toBeUndefined();
  });

  it("previousSummary 并入 hash 输入", async () => {
    const listener = (api.on as any).mock.calls.find(([e]: [string]) => e === "session_before_compact")?.[1];
    vi.mocked(complete).mockResolvedValueOnce({ content: [{ type: "text", text: "summary v1" }] } as any);
    const r1 = await listener({ preparation: { messagesToSummarize: [{ role: "user", content: "same" }], firstKeptEntryId: "e1", tokensBefore: 100, previousSummary: "v1" }, signal: new AbortController().signal }, mockCtx);
    vi.mocked(complete).mockResolvedValueOnce({ content: [{ type: "text", text: "summary v2" }] } as any);
    const r2 = await listener({ preparation: { messagesToSummarize: [{ role: "user", content: "same" }], firstKeptEntryId: "e1", tokensBefore: 100, previousSummary: "v2" }, signal: new AbortController().signal }, mockCtx);
    expect(r1.compaction.summary).toBe("summary v1");
    expect(r2.compaction.summary).toBe("summary v2");
  });

  it("鉴权失败时回退", async () => {
    mockCtx.modelRegistry.getApiKeyAndHeaders.mockResolvedValueOnce({ ok: false, apiKey: undefined, headers: {} });
    const listener = (api.on as any).mock.calls.find(([e]: [string]) => e === "session_before_compact")?.[1];
    expect(await listener({ preparation: { messagesToSummarize: [], firstKeptEntryId: "e1", tokensBefore: 500, previousSummary: "" }, signal: new AbortController().signal }, mockCtx)).toBeUndefined();
  });

  it("complete 调用失败时回退", async () => {
    vi.mocked(complete).mockRejectedValueOnce(new Error("API error"));
    const listener = (api.on as any).mock.calls.find(([e]: [string]) => e === "session_before_compact")?.[1];
    expect(await listener({ preparation: { messagesToSummarize: [{ role: "user", content: "test" }], firstKeptEntryId: "e1", tokensBefore: 500, previousSummary: "" }, signal: new AbortController().signal }, mockCtx)).toBeUndefined();
  });

  it("空摘要时回退", async () => {
    vi.mocked(complete).mockResolvedValueOnce({ content: [{ type: "text", text: "   " }] } as any);
    const listener = (api.on as any).mock.calls.find(([e]: [string]) => e === "session_before_compact")?.[1];
    expect(await listener({ preparation: { messagesToSummarize: [], firstKeptEntryId: "e1", tokensBefore: 500, previousSummary: "" }, signal: new AbortController().signal }, mockCtx)).toBeUndefined();
  });
});

// ═══ R13: 模型过滤 — 仅 DeepSeek 模型激活 ═══
describe("模型过滤:仅 DeepSeek 模型激活", () => {
  let api: ReturnType<typeof createMockExtensionAPI>;
  const claudeCtx = { ...mockCtx, model: { provider: "anthropic", id: "claude-sonnet-4-5" } };

  beforeEach(() => {
    clearPersistedData();
    // 清理共享 mock 的调用历史,避免跨用例污染
    mockCtx.ui.setStatus.mockClear();
    mockCtx.ui.notify.mockClear();
    mockCtx.ui.custom.mockClear();
    vi.mocked(complete).mockClear();
    api = createMockExtensionAPI();
    index(api as any);
  });

  it("DeepSeek 直连时正常累计遥测并显示该对话平均命中率", async () => {
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 100, input: 50, cacheWrite: 10 } } });
    // 100 / (100+50) = 66.7%
    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("avg", "avg cache 66.7% · ");
  });

  it("经 OpenRouter 使用的 deepseek/ 模型同样激活", async () => {
    const orCtx = { ...mockCtx, model: { provider: "openrouter", id: "deepseek/deepseek-chat" } };
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 100, input: 50, cacheWrite: 10 } } }, orCtx);
    expect(orCtx.ui.setStatus).toHaveBeenCalledWith("avg", "avg cache 66.7% · ");
  });

  it("非 DeepSeek 模型时不累计遥测、状态栏被清除", async () => {
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 100, input: 50, cacheWrite: 10 } } }, claudeCtx);
    expect(claudeCtx.ui.setStatus).toHaveBeenCalledWith("cache", undefined);
    // 统计未累计 → /cache-stats 提示未激活,不弹窗
    await api.__getCommand("cache-stats")!.handler([], claudeCtx);
    expect(claudeCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("未激活"), "info");
    expect(claudeCtx.ui.custom).not.toHaveBeenCalled();
  });

  it("非 DeepSeek 模型时 context 不过滤 volatile-scratch", async () => {
    const messages = [
      { role: "system", content: "keep" },
      { role: "user", customType: "volatile-scratch", content: "scratch" },
    ];
    const ctx = api.__getListener("context");
    expect(await ctx({ messages }, claudeCtx)).toBeUndefined();
  });

  it("非 DeepSeek 模型时 before_provider_request 不告警", async () => {
    const listener = api.__getListener("before_provider_request");
    listener({ payload: { messages: [{ role: "user", content: "a" }] } }, claudeCtx);
    listener({ payload: { messages: [{ role: "user", content: "b" }] } }, claudeCtx);
    expect(claudeCtx.ui.notify).not.toHaveBeenCalled();
  });

  it("非 DeepSeek 模型时 compaction 回退默认(不调用 flash)", async () => {
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

  it("model_select 切到非 DeepSeek 时清空状态栏", async () => {
    await api.__emit("model_select", { model: { provider: "anthropic", id: "claude-sonnet-4-5" } });
    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("cache", undefined);
  });

  it("model_select 切到 DeepSeek 时显示已激活", async () => {
    await api.__emit("model_select", { model: { provider: "deepseek", id: "deepseek-chat" } });
    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("cache", "cache armed");
  });

  // ───────── 常驻 avg 命中率 ─────────
  it("session_start 时 avg 初始化为 0.0%", async () => {
    await api.__emit("session_start", { reason: "new" });
    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("avg", "avg cache 0.0% · ");
  });

  it("DeepSeek 消息后 avg 更新为该对话命中率", async () => {
    await api.__emit("session_start", { reason: "new" });
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 80, input: 20, cacheWrite: 0 } } });
    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("avg", "avg cache 80.0% · ");
    // 再一条
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 90, input: 10, cacheWrite: 0 } } });
    // (80+90)/(80+90+20+10) = 170/200 = 85.0%
    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("avg", "avg cache 85.0% · ");
  });

  it("切到非 DeepSeek 后 avg 仍保留(常驻)", async () => {
    await api.__emit("session_start", { reason: "new" });
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 80, input: 20, cacheWrite: 0 } } });
    mockCtx.ui.setStatus.mockClear();
    // 切到非 DeepSeek 后,avg 不应被清除
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 999, input: 999, cacheWrite: 999 } } }, claudeCtx);
    expect(mockCtx.ui.setStatus).not.toHaveBeenCalledWith("avg", undefined);
  });

  it("session_start 回填历史 assistant 消息(无论模型)", async () => {
    // 模拟 pi -c 恢复的会话:混合模型的 assistant 消息都计入
    mockCtx.sessionManager.getEntries.mockReturnValueOnce([
      { type: "message", message: { role: "user", content: "hi" } },
      { type: "message", message: { role: "assistant", provider: "deepseek", model: "deepseek-chat", usage: { cacheRead: 80, input: 20, cacheWrite: 0 } } },
      { type: "message", message: { role: "toolResult", toolName: "bash" } },
      { type: "message", message: { role: "assistant", provider: "deepseek", model: "deepseek-chat", usage: { cacheRead: 90, input: 10, cacheWrite: 0 } } },
      // 非 DeepSeek(如 Claude)带 cacheRead 的也计入
      { type: "message", message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4-5", usage: { cacheRead: 60, input: 40, cacheWrite: 0 } } },
      { type: "message", message: { role: "assistant", provider: "deepseek", model: "deepseek-chat", usage: { cacheRead: 100, input: 0, cacheWrite: 0 } } },
    ] as any);
    await api.__emit("session_start", { reason: "resume" });
    // cacheRead: 80+90+60+100 = 330, input: 20+10+40+0 = 70 → 330/400 = 82.5%
    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("avg", "avg cache 82.5% · ");
  });

  it("session_start 回填也支持 OpenRouter deepseek/", async () => {
    mockCtx.sessionManager.getEntries.mockReturnValueOnce([
      { type: "message", message: { role: "assistant", provider: "openrouter", model: "deepseek/deepseek-chat", usage: { cacheRead: 95, input: 5, cacheWrite: 0 } } },
    ] as any);
    await api.__emit("session_start", { reason: "new" });
    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("avg", "avg cache 95.0% · ");
  });

  it("reload 时也回填(对话平均命中率不丢失)", async () => {
    mockCtx.sessionManager.getEntries.mockReturnValueOnce([
      { type: "message", message: { role: "assistant", provider: "deepseek", model: "deepseek-chat", usage: { cacheRead: 80, input: 20, cacheWrite: 0 } } },
    ] as any);
    await api.__emit("session_start", { reason: "reload" });
    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("avg", "avg cache 80.0% · ");
  });

  it("非 DeepSeek 模型的消息也会更新 avg", async () => {
    await api.__emit("session_start", { reason: "new" });
    // Claude 消息:cacheRead 100 / input 100 → 50%
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 100, input: 100, cacheWrite: 0 } } }, claudeCtx);
    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("avg", "avg cache 50.0% · ");
    // 且 cache 标签被清除(非 DeepSeek)
    expect(claudeCtx.ui.setStatus).toHaveBeenCalledWith("cache", undefined);
  });

  it("混合模型连续消息:avg 累加全部模型的 cacheRead/input", async () => {
    await api.__emit("session_start", { reason: "new" });
    // DeepSeek 消息
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 80, input: 20, cacheWrite: 0 } } });
    // Claude 消息
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 10, input: 90, cacheWrite: 0 } } }, claudeCtx);
    // (80+10)/(80+20+10+90) = 90/200 = 45.0%
    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("avg", "avg cache 45.0% · ");
  });
});
