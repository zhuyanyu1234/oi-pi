// 文件 CRUD 工具：read/write/edit/ls 复用 pi 现成工厂并包路径守卫，delete 自写（TUI 交互确认后才删）
import type { AgentTool, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { createEditTool, createLsTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { unlink, stat } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { WORKSPACE_ROOT } from "../config.js";

/** 路径守卫的放行根：工作目录 + /tmp */
const ALLOWED_ROOTS = [path.resolve(WORKSPACE_ROOT), path.resolve("/tmp")];

function withinAllowed(resolved: string): boolean {
  // 逐级向上找第一个真实存在的祖先做 realpath，防软链出界
  let probe = resolved;
  for (;;) {
    try {
      probe = realpathSync(probe);
      break;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return ALLOWED_ROOTS.some((root) => probe === root || probe.startsWith(root + path.sep));
}

/** 校验并解析路径；越界直接抛错 */
function assertAllowed(raw: string): string {
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(WORKSPACE_ROOT, raw);
  if (!withinAllowed(resolved)) {
    throw new Error(`路径越界：${resolved}（只允许工作目录 ${WORKSPACE_ROOT} 与 /tmp）`);
  }
  return resolved;
}

type AnyTool = AgentTool<any>;

/** 包一层参数路径校验（pi 工具本身不限路径） */
function guardPath(tool: AnyTool): AnyTool {
  return {
    ...tool,
    execute: async (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: AgentToolUpdateCallback<any>) => {
      if (typeof params?.path === "string") assertAllowed(params.path);
      return tool.execute(toolCallId, params, signal, onUpdate);
    },
  };
}

export type DeleteConfirm = (target: string, signal?: AbortSignal) => Promise<boolean>;

const deleteSchema = Type.Object({
  path: Type.String({ description: "要删除的文件路径（仅限工作目录内或 /tmp）" }),
});

export interface FileToolsOptions {
  /** 删除确认回调：返回 false / 抛错 / abort 一律不删（TUI 层弹交互确认） */
  confirmDelete: DeleteConfirm;
}

export function createFileTools(options: FileToolsOptions): AgentTool<any>[] {
  const deleteTool: AgentTool<typeof deleteSchema, { summary: string; deleted: string }> = {
    name: "delete_file",
    label: "删除文件",
    description:
      "删除一个文件（仅限工作目录内或 /tmp，不支持目录）。执行前会向用户弹出交互确认，用户同意才会真正删除；用户取消或中断则删除失败。",
    parameters: deleteSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params: { path: string }, signal?) {
      const target = assertAllowed(params.path);
      const st = await stat(target).catch(() => null);
      if (!st) throw new Error(`文件不存在：${target}`);
      if (!st.isFile()) throw new Error(`只支持删除文件，不支持目录：${target}`);
      const ok = await options.confirmDelete(target, signal);
      if (!ok) throw new Error("用户取消了删除");
      await unlink(target);
      return {
        content: [{ type: "text", text: `已删除 ${target}` }],
        details: { summary: `已删除 ${path.basename(target)}`, deleted: target },
      };
    },
  };

  return [
    guardPath(createReadTool(WORKSPACE_ROOT)),
    guardPath(createWriteTool(WORKSPACE_ROOT)),
    guardPath(createEditTool(WORKSPACE_ROOT)),
    guardPath(createLsTool(WORKSPACE_ROOT)),
    guardPath(deleteTool),
  ];
}
