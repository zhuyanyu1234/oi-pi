// hint 工具：学员完成题目后维护知识点掌握清单（prompts/knowledge.md）
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { readFileSync, writeFileSync } from "node:fs";
import { Type, type Static } from "typebox";
import { KNOWLEDGE_PROMPT_PATH } from "../prompts.js";

const Parameters = Type.Object({
  knowledge_point: Type.String({
    description: "知识点条目文本，需与 knowledge.md 中的条目匹配（尽量完整，如 线段树（区间查询 / 区间更新））",
  }),
  action: Type.Union(
    [Type.Literal("master"), Type.Literal("unmaster"), Type.Literal("annotate")],
    { description: "master=勾选已掌握；unmaster=取消勾选（发现薄弱）；annotate=只更新掌握等级备注" },
  ),
  note: Type.Optional(Type.String({ description: "掌握备注，如：等级 3：会模板会变通（master/annotate 时可带，替换原备注）" })),
});

type HintParams = Static<typeof Parameters>;

export interface HintDetails {
  summary: string;
  updated: boolean;
}

const CHECKBOX_RE = /^(\s*)- \[( |x)\] (.*)$/;

/** 把掌握备注写进条目文本：已有（等级...）备注则替换，否则追加 */
function withNote(text: string, note: string): string {
  if (/（等级/.test(text)) return text.replace(/（等级[^）]*）/, `（${note}）`);
  return `${text}（${note}）`;
}

export const hintTool: AgentTool<typeof Parameters, HintDetails> = {
  name: "hint",
  label: "知识库维护",
  description:
    "维护学员的知识点掌握清单（knowledge.md）。在题目完成、确认学生掌握后调用：把对应知识点勾选为已掌握；" +
    "发现学生某知识点薄弱或做错时，取消勾选；也可以只更新掌握等级备注。一次只更新一个条目。",
  parameters: Parameters,
  executionMode: "sequential",
  async execute(_toolCallId, params: HintParams, signal?, _onUpdate?: AgentToolUpdateCallback<HintDetails>): Promise<AgentToolResult<HintDetails>> {
    void signal;
    const raw = readFileSync(KNOWLEDGE_PROMPT_PATH, "utf8");
    const lines = raw.split("\n");
    const point = params.knowledge_point.trim();
    const note = params.note?.trim();

    let index = -1;
    for (const [i, line] of lines.entries()) {
      const m = line.match(CHECKBOX_RE);
      if (m && m[3]!.includes(point)) {
        index = i;
        break;
      }
    }
    if (index < 0) {
      const candidates = lines
        .map((l) => l.match(CHECKBOX_RE)?.[3])
        .filter((t): t is string => !!t && t.includes(point.slice(0, 2)))
        .slice(0, 8);
      const hints = candidates.length > 0 ? `\n相近条目：\n${candidates.map((c) => `- ${c}`).join("\n")}` : "";
      return {
        content: [{ type: "text", text: `未在 knowledge.md 中找到条目「${point}」。请用更接近的条目原文重试。${hints}` }],
        details: { summary: `未找到「${point}」`, updated: false },
      };
    }

    const oldLine = lines[index]!;
    const m = oldLine.match(CHECKBOX_RE)!;
    const indent = m[1]!;
    const text = m[3]!;
    let body = text;
    if (note && (params.action === "annotate" || params.action === "master")) body = withNote(text, note);
    const check = params.action === "master" ? "x" : params.action === "unmaster" ? " " : m[2]!;
    const newLine = `${indent}- [${check}] ${body}`;
    lines[index] = newLine;
    writeFileSync(KNOWLEDGE_PROMPT_PATH, lines.join("\n"), "utf8");

    const actionText = params.action === "master" ? "已掌握" : params.action === "unmaster" ? "取消勾选" : "更新备注";
    return {
      content: [{
        type: "text",
        text:
          `知识点清单已更新：\n  旧: ${oldLine.trim()}\n  新: ${newLine.trim()}\n` +
          `（文件已写入；当前会话内请以本次更新为准，/new 或重启后系统提示词刷新）`,
      }],
      details: { summary: `${actionText}：${point}`, updated: true },
    };
  },
};
