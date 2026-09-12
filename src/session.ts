import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { AGENT_DIR, parseModelRef } from "./config.js";
import { KNOWLEDGE_PROMPT_PATH, SYSTEM_PROMPT_PATH, readPromptFile, tryReadPromptFile } from "./prompts.js";
import { complexityTool } from "./tools/complexity.js";
import { createFileTools, type DeleteConfirm } from "./tools/files.js";
import { hintTool } from "./tools/hint.js";
import { judgeTool } from "./tools/judge.js";
import { stressTool } from "./tools/stress.js";

/** 主提示词在 prompts/system.md，知识点清单在 prompts/knowledge.md，内容归使用者维护；启动时读一次，改动需重启生效 */
function loadSystemPrompt(): string {
  let prompt = readPromptFile(SYSTEM_PROMPT_PATH).trim();
  if (!prompt) throw new Error(`主提示词为空（${SYSTEM_PROMPT_PATH}）`);

  // 知识点清单可选：存在则附加到提示词末尾，缺失只警告不阻断
  const knowledge = tryReadPromptFile(KNOWLEDGE_PROMPT_PATH)?.trim();
  if (knowledge) {
    prompt += "\n\n---\n\n" + knowledge;
  } else {
    process.stderr.write(`[oi-pi] 未找到知识点清单或内容为空（${KNOWLEDGE_PROMPT_PATH}），已跳过\n`);
  }
  return prompt;
}

/** 模型目录与凭据都来自本应用独立目录（~/.oi-pi/agent），与 pi 原生配置互不影响 */
export async function createModelRuntime(): Promise<ModelRuntime> {
  return ModelRuntime.create({
    modelsPath: join(AGENT_DIR, "models.json"),
    authPath: join(AGENT_DIR, "auth.json"),
  });
}

export function resolveModel(runtime: ModelRuntime) {
  const { provider, modelId } = parseModelRef();
  const model = runtime.getModel(provider, modelId);
  if (!model) throw new Error(`未找到模型 ${provider}/${modelId}，请检查 ${AGENT_DIR}/models.json`);
  return model;
}

const DEFAULT_TOOLS: AgentTool<any>[] = [judgeTool, stressTool, complexityTool, hintTool];

export const THINKING_LEVELS = new Set<string>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function envThinkingLevel(): ThinkingLevel {
  const raw = process.env.OI_PI_THINKING ?? "off";
  return (THINKING_LEVELS.has(raw) ? raw : "off") as ThinkingLevel;
}

/**
 * 组装一个 agent 会话。主界面和将来的子 agent 都走这个工厂：
 * 换 systemPrompt / tools 即可派生出不同角色，模型运行时（凭据、目录）复用同一份。
 */
export function createOiAgent(
  runtime: ModelRuntime,
  options?: {
    systemPrompt?: string;
    tools?: AgentTool<any>[];
    thinkingLevel?: ThinkingLevel;
    confirmDelete?: DeleteConfirm;
    /** 外部接入的工具（如 MCP），追加到默认工具集之后 */
    mcpTools?: AgentTool<any>[];
  },
): Agent {
  const model = resolveModel(runtime);
  const streamFn: StreamFn = (m, context, opts) => runtime.streamSimple(m, context, opts);
  const tools = options?.tools ?? [
    ...DEFAULT_TOOLS,
    ...createFileTools({ confirmDelete: options?.confirmDelete ?? (async () => false) }),
    ...(options?.mcpTools ?? []),
  ];
  return new Agent({
    streamFn,
    initialState: {
      systemPrompt: options?.systemPrompt ?? loadSystemPrompt(),
      model,
      thinkingLevel: options?.thinkingLevel ?? envThinkingLevel(),
      tools,
    },
  });
}
