// MCP 接入：读取 ~/.oi-pi/agent/mcp.json，用官方 SDK 把各服务器的工具接成 AgentTool（stdio 传输）
// 支持连接状态查询（/mcp）与单服务器重连
import type { AgentTool, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AGENT_DIR } from "./config.js";

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpConfig {
  servers?: Record<string, McpServerConfig>;
}

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: object;
}

export interface McpServerStatus {
  name: string;
  status: "ok" | "failed";
  toolNames: string[];
  error?: string;
}

const serverConfigs = new Map<string, McpServerConfig>();
const clients = new Map<string, Client>();
const serverStates = new Map<string, McpServerStatus>();

/** 连接一台 MCP 服务器（SDK 内部完成 initialize 握手） */
async function connectServer(name: string, sc: McpServerConfig): Promise<Client> {
  const client = new Client({ name: "oi-pi", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: sc.command,
    args: sc.args ?? [],
    env: { ...process.env, ...(sc.env ?? {}) } as Record<string, string>,
  });
  await client.connect(transport);
  return client;
}

function toAgentTool(client: Client, serverName: string, tool: McpToolDef): AgentTool<any> {
  const name = `${serverName}_${tool.name}`.replace(/[^A-Za-z0-9_-]/g, "_");
  return {
    name,
    label: `MCP ${serverName}: ${tool.name}`,
    description: tool.description || `MCP 服务器 ${serverName} 提供的工具 ${tool.name}`,
    // MCP 的 inputSchema 就是 JSON Schema，Type.Unsafe 直接桥进 typebox
    parameters: Type.Unsafe(tool.inputSchema ?? { type: "object", properties: {} }),
    execute: async (_toolCallId: string, args: unknown, _signal?: AbortSignal, _onUpdate?: AgentToolUpdateCallback<any>) => {
      const res = (await client.callTool({ name: tool.name, arguments: (args ?? {}) as Record<string, unknown> })) as {
        content?: any[];
        isError?: boolean;
      };
      const text = (res.content ?? [])
        .filter((c: any) => c?.type === "text")
        .map((c: any) => c.text)
        .join("\n");
      if (res.isError) throw new Error(text || `MCP 工具 ${tool.name} 执行失败`);
      return {
        content: [{ type: "text", text: text || "（无输出）" }],
        details: { summary: `${serverName}/${tool.name} 完成` },
      };
    },
  };
}

/** 连接并列出某服务器的工具；成功时记录状态并缓存 client */
async function connectAndMount(serverName: string, sc: McpServerConfig): Promise<AgentTool<any>[]> {
  const client = await connectServer(serverName, sc);
  const { tools: list = [] } = await client.listTools();
  clients.set(serverName, client);
  const defs = (list as McpToolDef[]).filter((t) => t?.name);
  const tools = defs.map((t) => toAgentTool(client, serverName, t));
  serverStates.set(serverName, {
    name: serverName,
    status: "ok",
    toolNames: defs.map((t) => t.name),
  });
  return tools;
}

function recordFailure(serverName: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  serverStates.set(serverName, { name: serverName, status: "failed", toolNames: [], error: message });
  process.stderr.write(`[oi-pi] MCP 服务器 ${serverName} 连接失败：${message}\n`);
}

/** 读取 mcp.json 并连接所有服务器；任何一台失败只警告不阻断。无配置时返回空数组 */
export async function initMcpTools(): Promise<AgentTool<any>[]> {
  let cfg: McpConfig;
  try {
    cfg = JSON.parse(readFileSync(join(AGENT_DIR, "mcp.json"), "utf8"));
  } catch {
    return [];
  }
  const all: AgentTool<any>[] = [];
  for (const [serverName, sc] of Object.entries(cfg.servers ?? {})) {
    if (!sc?.command) continue;
    serverConfigs.set(serverName, sc);
    try {
      all.push(...(await connectAndMount(serverName, sc)));
    } catch (err) {
      recordFailure(serverName, err);
    }
  }
  return all;
}

/** /mcp 用：各服务器连接状态（只读副本） */
export function getMcpState(): McpServerStatus[] {
  return [...serverStates.values()].map((s) => ({ ...s, toolNames: [...s.toolNames] }));
}

/** 重连一台服务器（先关旧连接），返回新挂载的工具；由调用方负责合并进 agent 工具集 */
export async function reconnectServer(name: string): Promise<AgentTool<any>[]> {
  const sc = serverConfigs.get(name);
  if (!sc) throw new Error(`未配置的 MCP 服务器：${name}`);
  const old = clients.get(name);
  if (old) {
    await old.close().catch(() => {});
    clients.delete(name);
  }
  const tools = await connectAndMount(name, sc);
  return tools;
}
