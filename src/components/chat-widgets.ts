// 聊天流自绘小组件与斜杠补全：不含 agent 状态，tui.ts 与冒烟测试共用
import { truncateToWidth, type AutocompleteItem, type AutocompleteProvider, type AutocompleteSuggestions, type Component } from "@earendil-works/pi-tui";
import { fg } from "../theme.js";

/** 左侧角色色条：包住消息组件，宽度让出 2 列 */
export class BarComponent<T extends Component = Component> implements Component {
  constructor(
    readonly inner: T,
    private readonly color: (s: string) => string,
  ) {}

  invalidate(): void {
    this.inner.invalidate();
  }

  render(width: number): string[] {
    return this.inner
      .render(Math.max(width - 2, 1))
      .map((l) => `${this.color("▌")} ${l}`);
  }
}

/** 全宽分割线 */
export class RuleComponent implements Component {
  invalidate(): void {}

  render(width: number): string[] {
    return [fg.dim("─".repeat(Math.max(width - 2, 0)))];
  }
}

/** 工具调用行：运行中 → 结束原地改写；失败时附报错原因（截断到宽度）；judge 结束后由事件层整块替换成判题卡片 */
export class ToolCallComponent implements Component {
  private startLine: string;
  private updateLine: string | null = null;
  private detailLines: string[] | null = null;

  constructor(toolName: string) {
    this.startLine = `  ${fg.accent("⏺")} ${fg.text(toolName)} ${fg.dim("运行中…")}`;
  }

  invalidate(): void {}

  setUpdate(text: string): void {
    this.updateLine = `  ${fg.dim("├")} ${fg.dim(text)}`;
  }

  finish(text: string, detail?: string): void {
    this.startLine = text;
    this.updateLine = null;
    this.detailLines = detail
      ? detail.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 2)
      : null;
  }

  render(width: number): string[] {
    const lines = this.updateLine ? [this.startLine, this.updateLine] : [this.startLine];
    if (this.detailLines) {
      for (const l of this.detailLines) {
        lines.push(`  ${fg.dim("└")} ${fg.dim(truncateToWidth(l, Math.max(width - 8, 1)))}`);
      }
    }
    return lines;
  }
}

// ---------- 斜杠命令补全（只补命令名） ----------

export const COMMANDS: AutocompleteItem[] = [
  { value: "/new", label: "/new", description: "新对话（自动保存当前对话）" },
  { value: "/resume", label: "/resume", description: "打开历史会话选择器" },
  { value: "/retry", label: "/retry", description: "重试上一轮失败的提问" },
  { value: "/compact", label: "/compact", description: "压缩对话历史，释放上下文" },
  { value: "/fork", label: "/fork", description: "从当前对话分叉出新会话" },
  { value: "/rewind", label: "/rewind", description: "回退到历史提问重跑/改答" },
  { value: "/status", label: "/status", description: "查看模型/上下文/工具等状态" },
  { value: "/stats", label: "/stats", description: "知识点掌握进度统计面板" },
  { value: "/edit", label: "/edit", description: "外部编辑器（$EDITOR）写长输入" },
  { value: "/mcp", label: "/mcp", description: "查看 MCP 服务器状态，重连失败的" },
  { value: "/del", label: "/del", description: "删除历史会话" },
  { value: "/export", label: "/export", description: "导出当前对话为 Markdown" },
  { value: "/model", label: "/model", description: "打开模型选择器" },
  { value: "/thinking", label: "/thinking", description: "思维链深度 off/low/medium/high" },
  { value: "/exit", label: "/exit", description: "退出" },
  { value: "/help", label: "/help", description: "显示帮助" },
];

export class SlashAutocomplete implements AutocompleteProvider {
  triggerCharacters = ["/"];

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    _options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const line = lines[cursorLine] ?? "";
    if (cursorLine !== 0 || !line.startsWith("/")) return null;
    const before = line.slice(0, cursorCol);
    const m = /(?:^|\s)(\/[^\s]*)$/.exec(before);
    if (!m?.[1]) return null;
    const token = m[1];
    const items = COMMANDS.filter((c) => c.value.startsWith(token) && c.value !== token);
    if (items.length === 0) return null;
    return { items, prefix: token };
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    const line = lines[cursorLine] ?? "";
    const start = cursorCol - prefix.length;
    const out = [...lines];
    out[cursorLine] = line.slice(0, start) + item.value + line.slice(cursorCol);
    return { lines: out, cursorLine, cursorCol: start + item.value.length };
  }
}
