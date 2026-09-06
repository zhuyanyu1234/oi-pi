import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// 轻量 .env 加载，避免引入 dotenv 依赖；已存在的环境变量不覆盖
try {
  for (const line of readFileSync(join(import.meta.dirname, "..", ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
    if (m?.[1] && m[2] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

/** 本应用独立配置目录（与 pi 的 ~/.pi/agent 完全隔离） */
export const AGENT_DIR = process.env.OI_PI_AGENT_DIR ?? join(homedir(), ".oi-pi", "agent");

/** agent 文件工具的允许根目录：默认进程 cwd，可用 OI_PI_WORKSPACE 覆盖；/tmp 始终额外放行 */
export const WORKSPACE_ROOT = process.env.OI_PI_WORKSPACE ?? process.cwd();

/** 模型引用，格式 provider/modelId，默认走 ~/.oi-pi/agent/models.json 里的 agnes */
export const MODEL_REF = process.env.OI_PI_MODEL ?? "agnes/agnes-2.5-flash";

export function parseModelRef(ref = MODEL_REF): { provider: string; modelId: string } {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1)
    throw new Error(`OI_PI_MODEL 格式应为 provider/modelId，当前: "${ref}"`);
  return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}
