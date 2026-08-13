import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 测试隔离:把数据目录重定向到临时目录,
// 避免污染/清空用户真实的 ~/.pi/agent/extensions/deepseek-cache
process.env.PI_DEEPSEEK_CACHE_DIR = mkdtempSync(
  join(tmpdir(), "pi-deepseek-cache-test-"),
);
