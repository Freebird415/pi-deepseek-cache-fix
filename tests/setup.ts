import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Test isolation: redirect the data directory to a temp dir so tests do not
// pollute or wipe the user's real ~/.pi/agent/extensions/deepseek-cache
process.env.PI_DEEPSEEK_CACHE_DIR = mkdtempSync(
  join(tmpdir(), "pi-deepseek-cache-test-"),
);
