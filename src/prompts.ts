// 提示词文件集中管理：路径常量 + 读取辅助（内容归使用者维护，启动时读一次）
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PROMPTS_DIR = join(import.meta.dirname, "..", "prompts");
export const SYSTEM_PROMPT_PATH = join(PROMPTS_DIR, "system.md");
export const KNOWLEDGE_PROMPT_PATH = join(PROMPTS_DIR, "knowledge.md");

/** 读取提示词文件，不存在时返回 undefined */
export function tryReadPromptFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** 读取提示词文件，不存在时抛出带路径的明确错误 */
export function readPromptFile(path: string): string {
  const content = tryReadPromptFile(path);
  if (content === undefined) throw new Error(`文件不存在：${path}`);
  return content;
}
