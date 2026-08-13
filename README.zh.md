# pi-deepseek-cache

> 本仓库是 [ruanbw/pi-deepseek-cache](https://github.com/ruanbw/pi-deepseek-cache) 的 fork，原作者 [@ruanbw](https://github.com/ruanbw)。
> 新增了「仅 DeepSeek 激活」「常驻平均命中率显示」「恢复会话时缓存回填」等功能。

一个 [Pi](https://pi.dev) 扩展，充分发挥 DeepSeek 提示缓存的优势：稳定提示前缀、更高缓存命中率、实时统计——让长会话成本降低约 90%。

## 功能特性

- **仅 DeepSeek 模型激活** — 仅在 DeepSeek 模型（直连 `deepseek`，或 `openrouter` 下 id 以 `deepseek/` 开头的模型）下运行，其他模型不受影响。
- **常驻平均命中率** — `avg cache xx.x%` 常驻显示整个对话（含所有模型）的缓存命中率。
- **`cache armed` 指示** — DeepSeek 模型激活时显示。
- **命中率遥测** — 累计 `cacheRead` / `input` / `cacheWrite` / `turns`，持久化到磁盘。
- **恢复时回填缓存** — 用 `pi -c` 恢复会话时，自动回填历史缓存统计。
- **前缀守卫** — 过滤 `volatile-scratch` 消息，只检测真正的缓存前缀变化（而非正常的对话增长）。
- **缓存友好压缩** — 用 `deepseek-v4-flash`（temperature 0）做确定性摘要，按哈希跨会话复用。
- **命令** — `/cache-stats`、`/cache-graph`、`/cache-reset`。

## 安装

需要 [Pi](https://pi.dev) 和 Node.js ≥ 18。

```bash
pi install git:github.com/Freebird415/pi-deepseek-cache-fix
```

### Windows 用户注意

安装前先执行一次（开启 git 长路径支持）。某个传递依赖的文件名极长，会超过 Windows 260 字符路径限制，导致安装时报 "Filename too long"：

```bash
git config --global core.longPaths true
```

## 使用

1. 配置 DeepSeek provider（设置 `DEEPSEEK_API_KEY`）。
2. 选择 DeepSeek 模型（如 `deepseek/deepseek-chat`）。
3. 扩展自动激活，底栏显示 `avg cache xx.x% · cache armed`。

## 命令

| 命令 | 说明 |
|------|------|
| `/cache-stats` | 命中率、缓存命中/未命中 token、轮次、预估节省 |
| `/cache-graph` | 缓存命中率 ASCII 趋势图 |
| `/cache-reset` | 清空所有统计、历史和摘要缓存 |

## 工作原理

| 层 | 说明 |
|----|------|
| **P1 — 遥测** | `message_end` 时累计 `cacheRead`/`input`/`cacheWrite`/`turns`，持久化到 `~/.pi/agent/extensions/deepseek-cache/` |
| **P2 — 前缀守卫** | `context` 钩子过滤 `volatile-scratch` 消息；SHA-256 指纹检测真正的缓存前缀变化 |
| **P3 — 压缩** | `deepseek-v4-flash`（temperature 0）确定性摘要，按 SHA-256 跨会话缓存 |

## 许可证

[MIT](./LICENSE) © Freebird415、[ruanbw](https://github.com/ruanbw)
