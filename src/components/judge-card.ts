// judge 判题卡片：全 AC 折叠成一行，否则 box 卡片列出每个测试点的 verdict/耗时/note
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { fg } from "../theme.js";

export interface JudgeTest {
  name: string;
  verdict: string;
  timeMs?: number;
  note?: string;
}

export interface JudgeDetails {
  summary: string;
  passed: number;
  total: number;
  tests: JudgeTest[];
}

export function isJudgeDetails(d: unknown): d is JudgeDetails {
  if (typeof d !== "object" || d === null) return false;
  const o = d as Record<string, unknown>;
  return (
    typeof o.summary === "string" &&
    typeof o.passed === "number" &&
    typeof o.total === "number" &&
    Array.isArray(o.tests)
  );
}

export function judgeAllPassed(d: JudgeDetails): boolean {
  return d.total > 0 && d.passed === d.total && d.tests.length === d.total;
}

const ICONS: Record<string, string> = { AC: "✓", WA: "✗", TLE: "✗", RE: "✗", CE: "✗" };
const COLORS: Record<string, (s: string) => string> = {
  AC: fg.success,
  WA: fg.error,
  TLE: fg.warning,
  RE: fg.error,
  CE: fg.error,
};

function totalMs(d: JudgeDetails): number {
  return d.tests.reduce((acc, t) => acc + (t.timeMs ?? 0), 0);
}

/** 全 AC 时的折叠行（也是卡片首行复用的渲染入口） */
export function judgeFoldedLine(d: JudgeDetails): string {
  const ms = totalMs(d);
  const time = ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
  return `  ${fg.success("✓ judge")} ${fg.dim(`${d.passed}/${d.total} 通过 · ${time}`)}`;
}

/** 按可见宽度截断（CJK 占 2 列），截断时补省略号 */
function clipToWidth(text: string, maxCols: number): string {
  if (maxCols <= 1) return "";
  let used = 0;
  let out = "";
  let truncated = false;
  for (const ch of text) {
    const w = visibleWidth(ch);
    if (used + w > maxCols - 1) {
      truncated = true;
      break;
    }
    used += w;
    out += ch;
  }
  return truncated ? `${out}…` : out;
}

export class JudgeCardComponent implements Component {
  constructor(
    private readonly details: JudgeDetails,
    private readonly errorText?: string, // CE 时的编译错误全文（取自工具结果文本）
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const d = this.details;
    if (judgeAllPassed(d)) return [judgeFoldedLine(d)];

    const indent = "  ";
    const outer = Math.max(width - indent.length - 1, 24);
    const inner = outer - 2;
    const lines: string[] = [];

    const title = ` judge 判题 ${d.passed}/${d.total} `;
    const fill = Math.max(outer - 3 - visibleWidth(title), 1);
    lines.push(`${indent}${fg.border("╭─" + title + "─".repeat(fill) + "╮")}`);

    for (const row of this.rows(inner)) {
      const pad = Math.max(inner - visibleWidth(row), 0);
      lines.push(`${indent}${fg.border("│")}${row}${" ".repeat(pad)}${fg.border("│")}`);
    }
    lines.push(`${indent}${fg.border("╰" + "─".repeat(inner) + "╯")}`);
    return lines;
  }

  private rows(inner: number): string[] {
    const d = this.details;
    if (d.tests.length === 0) return this.errorRows(inner);

    const out: string[] = [];
    for (const t of d.tests) {
      const color = COLORS[t.verdict] ?? fg.error;
      const icon = ICONS[t.verdict] ?? "✗";
      let cell = ` ${color(icon)} ${fg.text(t.name)} ${fg.dim("·")} ${color(t.verdict)}`;
      if (t.timeMs !== undefined) cell += ` ${fg.dim(`· ${t.timeMs}ms`)}`;
      if (t.note) {
        const room = inner - visibleWidth(cell) - 2;
        const note = clipToWidth(t.note, room);
        if (note) cell += `  ${fg.dim(note)}`;
      }
      out.push(cell);
    }
    return out;
  }

  private errorRows(inner: number): string[] {
    const out = [` ${fg.error("✗")} ${fg.error(this.details.summary)}`];
    const body = (this.errorText ?? "")
      .split("\n")
      .slice(1) // 首行是「编译失败：」前缀，标题已表达
      .filter((l) => l.trim() !== "");
    for (const l of body.slice(0, 3)) out.push(`   ${fg.dim(clipToWidth(l.trim(), inner - 5))}`);
    if (body.length > 3) out.push(`   ${fg.dim("…")}`);
    return out;
  }
}
