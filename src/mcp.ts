// MCP 接入：读取 ~/.oi-pi/agent/mcp.json，用官方 SDK 把各服务器的工具接成 AgentTool（stdio 传输）
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

/** 读取 mcp.json 并连接所有服务器；任何一台失败只警告不阻断。无配置时返回空数组 */
export async function initMcpTools(): Promise<AgentTool<any>[]> {
  let cfg: McpConfig;
  try {
    cfg = JSON.parse(readFileSync(join(AGENT_DIR, "mcp.json"), "utf8"));
  } catch {
    return [];
  }
  const tools: AgentTool<any>[] = [];
  for (const [serverName, sc] of Object.entries(cfg.servers ?? {})) {
    if (!sc?.command) continue;
    try {
      const client = await connectServer(serverName, sc);
      try {
        const { tools: list = [] } = await client.listTools();
        for (const t of list as McpToolDef[]) {
          if (!t?.name) continue;
          tools.push(toAgentTool(client, serverName, t));
        }
      } catch (err) {
        await client.close().catch(() => {});
        throw err;
      }
    } catch (err) {
      process.stderr.write(`[oi-pi] MCP 服务器 ${serverName} 连接失败：${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  return tools;
}
