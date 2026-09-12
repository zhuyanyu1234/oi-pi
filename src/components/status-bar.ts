// 底部状态栏：反色 statusline 单行条 = 模型 · 会话累计 token/费用 · 生成中 spinner + 耗时
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { palette } from "../theme.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

interface UsageLike {
  input?: number;
  output?: number;
  cost?: { total?: number };
}

/** 每段独立带底色上色：内部 \x1b[0m 会重置背景，不能整行包一层 */
function seg(text: string, hexFg: string): string {
  const [fr, fgc, fb] = rgbOf(hexFg);
  const [br, bgc, bb] = rgbOf(palette.surface1);
  return `\x1b[48;2;${br};${bgc};${bb};38;2;${fr};${fgc};${fb}m${text}\x1b[0m`;
}

function rgbOf(hexColor: string): [number, number, number] {
  const n = parseInt(hexColor.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
}

export class StatusBar implements Component {
  private model = "";
  private inputTok = 0;
  private outputTok = 0;
  private cost = 0;
  private ctxUsed = 0;
  private ctxWindow = 0;
  private spinnerIdx = 0;
  private since: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly onTick: () => void) {}

  invalidate(): void {}

  setModel(name: string): void {
    this.model = name;
  }

  /** 最近一次请求的上下文占用（输入 token）与模型窗口，用于 ctx% 显示 */
  setContext(used: number, window: number): void {
    this.ctxUsed = used;
    if (window > 0) this.ctxWindow = window;
  }

  addUsage(usage: UsageLike | undefined): void {
    if (!usage) return;
    this.inputTok += usage.input ?? 0;
    this.outputTok += usage.output ?? 0;
    this.cost += usage.cost?.total ?? 0;
  }

  reset(): void {
    this.inputTok = 0;
    this.outputTok = 0;
    this.cost = 0;
    this.ctxUsed = 0;
  }

  startStreaming(): void {
    if (this.timer) return;
    this.since = Date.now();
    this.timer = setInterval(() => {
      this.spinnerIdx = (this.spinnerIdx + 1) % SPINNER.length;
      this.onTick();
    }, 120);
  }

  stopStreaming(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.since = null;
  }

  render(width: number): string[] {
    const parts: string[] = [];
    if (this.model) parts.push(seg(this.model, palette.text));
    if (this.ctxWindow > 0 && this.ctxUsed > 0) {
      const pct = this.ctxUsed / this.ctxWindow;
      const color = pct >= 0.9 ? palette.red : pct >= 0.75 ? palette.yellow : palette.overlay1;
      parts.push(seg(`ctx ${(pct * 100).toFixed(0)}%`, color));
    }
    if (this.inputTok + this.outputTok > 0 || this.cost > 0) {
      parts.push(seg(`↑${fmtTok(this.inputTok)} ↓${fmtTok(this.outputTok)} tok`, palette.overlay1));
      if (this.cost > 0) parts.push(seg(`$${this.cost.toFixed(4)}`, palette.overlay1));
    }
    if (this.since !== null) {
      const elapsed = Math.floor((Date.now() - this.since) / 1000);
      parts.push(seg(`${SPINNER[this.spinnerIdx]} ${elapsed}s`, palette.green));
    }
    const text = parts.join(seg(" · ", palette.surface2));
    const pad = Math.max(width - visibleWidth(text), 0);
    return [text + seg(" ".repeat(pad), palette.surface1)];
  }
}
