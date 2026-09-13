#!/usr/bin/env node
// oi-pi 自研 TUI：pi-tui 组件库 + pi-agent-core Agent 直接组装，不使用 pi 的 InteractiveMode
import {
  Container,
  Editor,
  Loader,
  matchesKey,
  ProcessTerminal,
  SelectList,
  Text,
  TuiMainScreen,
  type SelectItem,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  AssistantMessageComponent,
  getMarkdownTheme,
  getSelectListTheme,
  initTheme,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_DIR, WORKSPACE_ROOT } from "./config.js";
import type { Agent, AgentEvent, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  JudgeCardComponent,
  isJudgeDetails,
  judgeAllPassed,
  judgeFoldedLine,
  type JudgeDetails,
} from "./components/judge-card.js";
import { StatusBar } from "./components/status-bar.js";
import { BarComponent, RuleComponent, SlashAutocomplete, ToolCallComponent } from "./components/chat-widgets.js";
import { createModelRuntime, createOiAgent, THINKING_LEVELS } from "./session.js";
import { getMcpState, initMcpTools, reconnectServer } from "./mcp.js";
import { bold, fg } from "./theme.js";
import { deleteSession, listSessions, loadSession, newSessionId, saveSession } from "./session-store.js";

// 自带 Catppuccin Mocha 主题：把主题文件装进 agent 目录的 themes/ 后按名加载，
// pi 渲染的一切（markdown/语法高亮/思维链/选择器/编辑器配色）统一到同一色板。
// pi 按 PI_CODING_AGENT_DIR 解析 agent 目录，指到我们的 AGENT_DIR 就不会碰 ~/.pi
try {
  process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
  const themeSrc = join(import.meta.dirname, "..", "themes", "catppuccin-mocha.json");
  const themeDst = join(AGENT_DIR, "themes", "catppuccin-mocha.json");
  mkdirSync(join(AGENT_DIR, "themes"), { recursive: true });
  copyFileSync(themeSrc, themeDst);
  initTheme("catppuccin-mocha");
} catch {
  initTheme("dark");
}

const runtime = await createModelRuntime();
const mcpTools = await initMcpTools();

const tui: TUI = new TuiMainScreen(new ProcessTerminal());
const chat = new Container();
const statusBar = new StatusBar(() => tui.requestRender());

const addLine = (text: string, paddingX = 1) => {
  chat.addChild(new Text(text, paddingX, 0));
  tui.requestRender();
};

// ---------- 输入历史持久化（↑↓ 跨会话找回输过的内容） ----------

const HISTORY_FILE = join(AGENT_DIR, "history.json");
const HISTORY_CAP = 200;

function loadPromptHistory(): string[] {
  try {
    const arr = JSON.parse(readFileSync(HISTORY_FILE, "utf8"));
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string" && x.trim() !== "").slice(-HISTORY_CAP) : [];
  } catch {
    return [];
  }
}

function appendPromptHistory(text: string): void {
  try {
    const list = loadPromptHistory();
    if (list[list.length - 1] === text) return; // 连续重复不记
    list.push(text);
    writeFileSync(HISTORY_FILE, JSON.stringify(list.slice(-HISTORY_CAP)), "utf8");
  } catch {
    // 历史写失败无关紧要
  }
}

// ---------- header / 帮助 ----------

const ART = [" ___  ___  ___", "| _ \\/ _ \\|_ _|", "|  _/ (_) || |", "|_|  \\___/|___|"];

const PACKAGE_VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

function addHeader() {
  for (const l of ART) addLine(fg.accent(l), 1);
  addLine(
    fg.muted(`信奥助教 v${PACKAGE_VERSION} · ${agent.state.model.name} · /help 查看命令 · Esc/Ctrl+C 中断，空闲退出`),
    1,
  );
  chat.addChild(new RuleComponent());
  tui.requestRender();
}

function printHelp() {
  const lines = [
    "/new           新对话（自动保存当前对话，提示词改动此时生效）",
    "/resume        打开历史会话选择器",
    "/retry         重试上一轮失败的提问（限流/超时类错误会自动退避重试 ≤2 次）",
    "/rewind        回退到历史任意提问处：原样重跑或撤掉重新输入",
    "/compact       压缩对话历史为摘要（上下文吃紧时用，看状态栏 ctx%；超阈值也会自动压缩）",
    "/fork          从当前对话分叉出新会话（原会话停在分叉点）",
    "/del           删除历史会话",
    "/export        导出当前对话为 Markdown",
    "/model [ref]   打开模型选择器 / 直接切换 provider/id",
    "/status        查看模型/上下文占用/累计用量/工具清单/会话信息",
    "/mcp           查看 MCP 服务器状态与工具，重连失败的",
    "/thinking [级] 查看/切换思维链深度（off|minimal|low|medium|high|xhigh|max，模型需支持）",
    "/exit          退出",
    "/help          显示本帮助",
    "生成中继续打字会排队，本轮结束后自动发送；Esc/Ctrl+C 中断生成；输入 / 补全命令；选择器内 ↑↓ 选择，Esc 取消",
  ];
  for (const l of lines) addLine(fg.dim(l));
}

// ---------- 状态 ----------

// agent 可整体重建（/new、/resume 时重载提示词与模型），事件处理器绑定在 let 变量上
let agent: Agent = buildAgent();
let sessionId = newSessionId();
let streaming: BarComponent | null = null;
let streamingMsg: AssistantMessageComponent | null = null;
let loader: Loader | null = null;
let openList: SelectList | null = null;
const toolCalls = new Map<string, ToolCallComponent>();
let msgStartAt: number | null = null;
let sawError = false;
let sawAbort = false;
let lastTurnFailed = false;
let autoRetries = 0;
let compacting = false;

// 上下文占用达到该比例自动压缩（agent 空闲时触发）；OI_PI_AUTOCOMPACT=0 关闭
const AUTOCOMPACT_THRESHOLD = (() => {
  const v = parseFloat(process.env.OI_PI_AUTOCOMPACT ?? "0.85");
  return Number.isFinite(v) && v > 0 && v < 1 ? v : 0;
})();

function buildAgent(): Agent {
  const a = createOiAgent(runtime, { confirmDelete: confirmDeleteInTui, mcpTools });
  a.subscribe(handleAgentEvent);
  return a;
}

function modelRef(): { provider: string; id: string } {
  return { provider: agent.state.model.provider, id: agent.state.model.id };
}

function saveCurrent(): void {
  const messages = agent.state.messages;
  if (messages.length === 0) return;
  try {
    saveSession(sessionId, { model: modelRef(), messages: [...messages] });
  } catch (err) {
    addLine(fg.warning(`会话保存失败：${err instanceof Error ? err.message : String(err)}`));
  }
}

function availableModels() {
  const snapshot = runtime.getAvailableSnapshot();
  return snapshot.length > 0 ? [...snapshot] : [...runtime.getModels()];
}

const removeLoader = () => {
  if (loader) {
    chat.removeChild(loader);
    loader = null;
  }
};

// ---------- 消息渲染 ----------

function extractText(content: unknown, sep = " "): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p: any) => p?.type === "text")
    .map((p: any) => p.text)
    .join(sep);
}

function appendJudgeCard(details: JudgeDetails, errorText?: string): void {
  if (judgeAllPassed(details)) {
    chat.addChild(new Text(judgeFoldedLine(details), 0, 0));
  } else {
    chat.addChild(new JudgeCardComponent(details, errorText));
  }
}

/** 重放历史消息（/resume）：judge 结果重渲染成卡片，其余工具结果收成一行 dim */
function renderHistory(messages: any[]): void {
  for (const msg of messages) {
    if (msg?.role === "user") {
      chat.addChild(new BarComponent(new UserMessageComponent(extractText(msg.content), getMarkdownTheme()), fg.accent2));
    } else if (msg?.role === "assistant") {
      const content = (msg.content ?? []) as any[];
      const visible =
        content.some((c) => (c?.type === "text" && c.text?.trim()) || (c?.type === "thinking" && c.thinking?.trim())) ||
        content.some((c) => c?.type === "toolCall");
      // 干净结束却空内容的消息直接跳过，不留空 ▌ 条；abort/error 的保留（组件内有状态行）
      if (visible || msg.stopReason === "aborted" || msg.stopReason === "error") {
        const hasThinking = content.some((c) => c?.type === "thinking" && typeof c.thinking === "string" && c.thinking.trim());
        const comp = new AssistantMessageComponent(
          msg as AssistantMessage,
          hasThinking,
          getMarkdownTheme(),
          hasThinking ? "✦ 已思考" : undefined,
        );
        chat.addChild(new BarComponent(comp, fg.accent));
      }
    } else if (msg?.role === "toolResult") {
      if (msg.toolName === "judge" && isJudgeDetails(msg.details)) {
        appendJudgeCard(msg.details as JudgeDetails, extractText(msg.content, "\n"));
      } else {
        const summary = typeof msg.details?.summary === "string" ? msg.details.summary : "";
        const label = `${msg.toolName ?? "tool"} ${summary}`.trim();
        chat.addChild(new Text(`  ${fg.dim(`┆ ${label}`)}`, 0, 0));
      }
    }
  }
}

// ---------- 选择器 ----------

let selectorCancelHook: (() => void) | null = null;

function closeSelector(notifyCancel = false): void {
  if (!openList) return;
  chat.removeChild(openList);
  openList = null;
  tui.setFocus(editor);
  tui.requestRender();
  const hook = selectorCancelHook;
  selectorCancelHook = null;
  if (notifyCancel) hook?.();
}

function openSelector(items: SelectItem[], onPick: (value: string) => void, onCancel?: () => void): void {
  closeSelector();
  const list = new SelectList(items, 10, getSelectListTheme());
  list.onSelect = (item) => {
    closeSelector();
    onPick(item.value);
  };
  list.onCancel = () => closeSelector(true);
  selectorCancelHook = onCancel ?? null;
  openList = list;
  chat.addChild(list);
  tui.setFocus(list);
  tui.requestRender();
}

/** agent 调 delete_file 时的 TUI 交互确认：用户明确选择「确认」才返回 true */
function confirmDeleteInTui(target: string, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: boolean) => {
      if (settled) return;
      settled = true;
      clearInterval(watch);
      resolve(v);
    };
    const watch = setInterval(() => {
      if (signal?.aborted) {
        closeSelector(true);
        finish(false);
      }
    }, 200);
    openSelector(
      [
        { value: "yes", label: `删除 ${target}`, description: "确认删除（不可恢复）" },
        { value: "no", label: "取消", description: "保留文件" },
      ],
      (v) => finish(v === "yes"),
      () => finish(false),
    );
  });
}

function openModelSelector(): void {
  const list = availableModels();
  if (list.length === 0) {
    addLine(fg.warning("没有可用模型，请检查 ~/.oi-pi/agent/models.json"));
    return;
  }
  const items: SelectItem[] = list.map((m) => {
    const current = m.provider === agent.state.model.provider && m.id === agent.state.model.id;
    return {
      value: `${m.provider}/${m.id}`,
      label: `${m.name}${current ? "  ← 当前" : ""}`,
      description: `${m.provider}/${m.id}`,
    };
  });
  openSelector(items, (ref) => switchModel(ref));
}

function openResumeSelector(): void {
  const sessions = listSessions();
  if (sessions.length === 0) {
    addLine(fg.dim("还没有历史会话"));
    return;
  }
  const items: SelectItem[] = sessions.slice(0, 10).map((s) => ({
    value: s.id,
    label: s.title,
    description: `${s.savedAt.slice(0, 16).replace("T", " ")} · ${s.messageCount} 条`,
  }));
  openSelector(items, (id) => resumeSession(id));
}

function openDeleteSelector(): void {
  const sessions = listSessions();
  if (sessions.length === 0) {
    addLine(fg.dim("还没有历史会话"));
    return;
  }
  const items: SelectItem[] = sessions.slice(0, 10).map((s) => ({
    value: s.id,
    label: s.title,
    description: `${s.savedAt.slice(0, 16).replace("T", " ")} · ${s.messageCount} 条`,
  }));
  openSelector(
    items,
    (id) => {
      if (id === sessionId) {
        addLine(fg.warning("当前会话不能删除（先 /new 切走再删）"));
        return;
      }
      const title = items.find((i) => i.value === id)?.label ?? id;
      void confirmDeleteInTui(`会话「${title}」`).then((ok) => {
        if (!ok) {
          addLine(fg.dim("已取消删除"));
          return;
        }
        try {
          deleteSession(id);
          addLine(fg.dim(`✕ 已删除会话「${title}」`));
        } catch (err) {
          addLine(fg.error(`删除失败：${err instanceof Error ? err.message : String(err)}`));
        }
      });
    },
  );
}

function exportSession(): void {
  const msgs = agent.state.messages;
  if (msgs.length === 0) {
    addLine(fg.warning("当前没有对话可导出"));
    return;
  }
  const out: string[] = [
    "# oi-pi 对话导出",
    "",
    `- 模型：${agent.state.model.name}`,
    `- 导出时间：${new Date().toLocaleString("zh-CN")}`,
    `- 消息数：${msgs.length}`,
    "",
    "---",
    "",
  ];
  for (const m of msgs) {
    if (m?.role === "user") {
      out.push("**👤 用户**", "", extractText(m.content), "");
    } else if (m?.role === "assistant") {
      const text = (m.content ?? [])
        .filter((c: any) => c?.type === "text")
        .map((c: any) => c.text)
        .join("\n");
      if (text.trim()) out.push("**🤖 教练**", "", text, "");
    } else if (m?.role === "toolResult") {
      const summary = typeof m.details?.summary === "string" ? m.details.summary : "";
      out.push(`> ⚙️ ${m.toolName ?? "tool"} ${summary}`.trimEnd(), "");
    }
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  const file = join(WORKSPACE_ROOT, `oi-pi-导出-${stamp}.md`);
  try {
    writeFileSync(file, out.join("\n"), "utf8");
    addLine(fg.dim(`⇩ 已导出：${file}`));
  } catch (err) {
    addLine(fg.error(`导出失败：${err instanceof Error ? err.message : String(err)}`));
  }
}

/** 同步终端窗口标题（多标签页时定位当前在问什么） */
function setTerminalTitle(text: string): void {
  const clean = text.replace(/[\x00-\x1f\x07]/g, "").slice(0, 40);
  process.stdout.write(`\x1b]0;oi-pi · ${clean}\x07`);
}

// ---------- 命令 ----------

function switchModel(ref: string): void {
  const target = availableModels().find((m) => `${m.provider}/${m.id}` === ref || m.id === ref);
  if (!target) {
    addLine(fg.warning(`未找到模型「${ref}」，/model 打开选择器`));
    return;
  }
  agent.state.model = target;
  statusBar.setModel(target.name);
  saveCurrent();
  addLine(fg.dim(`已切换到 ${target.name}（${target.provider}/${target.id}）`));
}

function resumeSession(id: string): void {
  let loaded;
  try {
    loaded = loadSession(id);
  } catch {
    addLine(fg.error(`会话文件损坏：${id}`));
    return;
  }
  agent = buildAgent(); // 顺带重载提示词
  sessionId = id;
  const saved = loaded.model ? runtime.getModel(loaded.model.provider, loaded.model.id) : undefined;
  if (saved) agent.state.model = saved;
  agent.state.messages = loaded.messages;

  chat.clear();
  addHeader();
  renderHistory(loaded.messages);

  syncStatusFromMessages(loaded.messages);

  addLine(fg.dim(`已恢复 ${loaded.messages.length} 条消息（模型：${agent.state.model.name}）`));
  addLine("", 0);
  tui.requestRender();
}

function onSubmit(text: string) {
  const input = text.trim();
  if (!input) return;
  editor.addToHistory(input);
  appendPromptHistory(input);

  if (input.startsWith("/")) {
    const space = input.indexOf(" ");
    const cmd = space < 0 ? input : input.slice(0, space);
    const arg = space < 0 ? "" : input.slice(space + 1).trim();
    if (cmd === "/exit" || cmd === "/quit") {
      saveCurrent();
      tui.stop();
      process.exit(0);
    } else if (cmd === "/model") {
      if (agent.state.isStreaming) addLine(fg.warning("正在生成中，稍后再切换模型"));
      else if (arg) switchModel(arg);
      else openModelSelector();
    } else if (cmd === "/new") {
      if (agent.state.isStreaming) {
        addLine(fg.warning("正在生成中，请等当前回答完成或 Ctrl+C 中断后再 /new"));
        return;
      }
      if (compacting) {
        addLine(fg.warning("正在压缩对话，稍后再操作"));
        return;
      }
      saveCurrent();
      sessionId = newSessionId();
      agent = buildAgent(); // 重建 = 重读 prompts/*.md，hint/提示词改动此时生效
      statusBar.reset();
      statusBar.setModel(agent.state.model.name);
      chat.clear();
      addHeader();
    } else if (cmd === "/resume") {
      if (agent.state.isStreaming) {
        addLine(fg.warning("正在生成中，请等当前回答完成或 Ctrl+C 中断后再 /resume"));
      } else if (compacting) {
        addLine(fg.warning("正在压缩对话，稍后再操作"));
      } else if (arg) {
        addLine(fg.warning("直接输入 /resume 打开选择器"));
      } else {
        openResumeSelector();
      }
    } else if (cmd === "/retry") {
      if (agent.state.isStreaming) {
        addLine(fg.warning("正在生成中，无法重试"));
      } else if (compacting) {
        addLine(fg.warning("正在压缩对话，稍后再操作"));
      } else if (!lastTurnFailed) {
        addLine(fg.warning("上一轮没有失败，无需重试"));
      } else {
        autoRetries = 0; // 手动接管，自动重试预算重置
        rerunLastQuestion("重试");
      }
    } else if (cmd === "/compact") {
      if (agent.state.isStreaming) {
        addLine(fg.warning("正在生成中，稍后再压缩"));
      } else {
        void compactSession();
      }
    } else if (cmd === "/fork") {
      if (agent.state.isStreaming) {
        addLine(fg.warning("正在生成中，稍后再分叉"));
      } else if (compacting) {
        addLine(fg.warning("正在压缩对话，稍后再操作"));
      } else if (agent.state.messages.length === 0) {
        addLine(fg.warning("没有可分叉的对话"));
      } else {
        saveCurrent(); // 原会话保持在分叉点
        const forkId = newSessionId();
        saveSession(forkId, { model: modelRef(), messages: [...agent.state.messages] });
        sessionId = forkId;
        addLine(fg.dim("⑂ 已分叉出新会话：后续对话写入新会话，原会话停在分叉点"));
      }
    } else if (cmd === "/del") {
      openDeleteSelector();
    } else if (cmd === "/export") {
      exportSession();
    } else if (cmd === "/rewind") {
      if (agent.state.isStreaming || compacting) {
        addLine(fg.warning("稍等，当前有事在进行"));
        return;
      }
      const msgs = agent.state.messages;
      const questions = msgs
        .map((m, i) => (m?.role === "user" ? { idx: i, text: extractText(m.content) } : null))
        .filter((q): q is { idx: number; text: string } => q !== null && q.text.trim() !== "");
      if (questions.length === 0) {
        addLine(fg.warning("没有可回退的提问"));
        return;
      }
      const items: SelectItem[] = questions.slice(-10).reverse().map((q) => {
        const flat = q.text.replace(/\s+/g, " ");
        return {
          value: String(q.idx),
          label: flat.length > 36 ? `${flat.slice(0, 36)}…` : flat,
          description: `第 ${q.idx + 1} 条消息`,
        };
      });
      openSelector(items, (v) => {
        const idx = Number(v);
        const qText = items.find((i) => i.value === v)?.label ?? "";
        openSelector(
          [
            { value: "rerun", label: "重跑该问题", description: "回退后立即重新生成回答" },
            { value: "edit", label: "回退后自己重新输入", description: "撤掉这条提问及其后的内容" },
          ],
          (choice) => {
            const keep = choice === "rerun" ? idx + 1 : idx;
            agent.state.messages = msgs.slice(0, keep);
            chat.clear();
            addHeader();
            renderHistory(agent.state.messages);
            syncStatusFromMessages(agent.state.messages);
            saveCurrent();
            sawError = false;
            sawAbort = false;
            lastTurnFailed = false;
            autoRetries = 0;
            if (choice === "rerun") {
              addLine(fg.dim(`⏪ 已回退并重跑：${qText}`));
              statusBar.startStreaming();
              agent.continue().catch((err: unknown) => {
                statusBar.stopStreaming();
                lastTurnFailed = true;
                addLine(fg.error(`✗ ${err instanceof Error ? err.message : String(err)}`));
              });
            } else {
              addLine(fg.dim(`⏪ 已回退：撤掉了 ${msgs.length - keep} 条消息，重新提问吧`));
            }
            tui.requestRender();
          },
        );
      });
    } else if (cmd === "/status") {
      const s = statusBar.snapshot;
      addLine(fg.text("── oi-pi 状态 ──"), 0);
      addLine(fg.muted(`模型：${agent.state.model.name}（${modelRef().provider}/${modelRef().id}）`));
      addLine(fg.muted(`上下文窗口：${agent.state.model.contextWindow ?? "?"} tok · 已用 ${(s.ctxPct * 100).toFixed(0)}%`));
      addLine(fg.muted(`会话累计：↑${s.inputTok} ↓${s.outputTok} tok · $${s.cost.toFixed(4)}`));
      addLine(fg.muted(`思维链：${agent.state.thinkingLevel} · 版本：v${PACKAGE_VERSION} · 自动压缩：${AUTOCOMPACT_THRESHOLD > 0 ? `≥${(AUTOCOMPACT_THRESHOLD * 100).toFixed(0)}%` : "关"}`));
      addLine(fg.muted(`会话 id：${sessionId}`));
      addLine(fg.muted(`工作目录：${WORKSPACE_ROOT}`));
      addLine(fg.muted(`工具（${agent.state.tools.length}）：${agent.state.tools.map((t) => t.name).join("、")}`));
    } else if (cmd === "/mcp") {
      const st = getMcpState();
      if (st.length === 0) {
        addLine(fg.dim("未配置 MCP 服务器（~/.oi-pi/agent/mcp.json）"));
        return;
      }
      for (const s of st) {
        const icon = s.status === "ok" ? fg.success("✓") : fg.error("✗");
        addLine(fg.dim(`${icon} ${s.name} · ${s.status === "ok" ? `${s.toolNames.length} 个工具` : s.error ?? "连接失败"}`));
        for (const t of s.toolNames) addLine(fg.dim(`      ${t}`));
      }
      const failed = st.filter((s) => s.status === "failed");
      if (failed.length === 0) return;
      if (agent.state.isStreaming || compacting) {
        addLine(fg.dim("当前有事在进行，稍后可重连失败的服务器"));
        return;
      }
      openSelector(
        failed.map((s) => ({ value: s.name, label: `重连 ${s.name}`, description: s.error ?? "连接失败" })),
        (name) => {
          addLine(fg.dim(`⟳ 正在重连 ${name}…`));
          reconnectServer(name)
            .then((tools) => {
              // 旧的重名工具换成新连接的
              agent.state.tools = [...agent.state.tools.filter((t) => !t.name.startsWith(`${name}_`)), ...tools];
              addLine(fg.dim(`✓ ${name} 已重连，挂载 ${tools.length} 个工具`));
            })
            .catch((err: unknown) => {
              addLine(fg.error(`✗ ${name} 重连失败：${err instanceof Error ? err.message : String(err)}`));
            });
        },
      );
    } else if (cmd === "/thinking") {
      if (agent.state.isStreaming) {
        addLine(fg.warning("正在生成中，稍后再切换思维链深度"));
      } else if (!arg) {
        addLine(fg.dim(`当前思维链深度：${agent.state.thinkingLevel}（/thinking off|minimal|low|medium|high|xhigh|max）`));
      } else if (!THINKING_LEVELS.has(arg)) {
        addLine(fg.warning(`无效级别「${arg}」，可选 off|minimal|low|medium|high|xhigh|max`));
      } else {
        agent.state.thinkingLevel = arg as ThinkingLevel;
        addLine(fg.dim(`思维链深度已切换 → ${arg}`));
      }
    } else if (cmd === "/help") {
      printHelp();
    } else {
      addLine(fg.warning(`未知命令 ${cmd}，/help 查看可用命令`));
    }
    return;
  }

  if (agent.state.isStreaming) {
    // 生成中不再拒绝输入：排队（steer），本轮回答结束后自动进入上下文
    const queued: UserMessage = { role: "user", content: input, timestamp: Date.now() };
    agent.steer(queued);
    chat.addChild(new BarComponent(new UserMessageComponent(input, getMarkdownTheme()), fg.accent2));
    addLine(fg.dim("  ⏳ 已排队，本轮回答结束后发送"), 0);
    tui.requestRender();
    return;
  }

  sawError = false;
  sawAbort = false;
  lastTurnFailed = false;
  autoRetries = 0;
  setTerminalTitle(input);
  chat.addChild(new BarComponent(new UserMessageComponent(input, getMarkdownTheme()), fg.accent2));
  loader = new Loader(tui, (s) => fg.accent(s), (s) => fg.muted(s), "思考中…");
  chat.addChild(loader);
  statusBar.startStreaming();
  agent.prompt(input).catch((err: unknown) => {
    removeLoader();
    statusBar.stopStreaming();
    const message = err instanceof Error ? err.message : String(err);
    addLine(fg.error(`✗ ${message}`));
  });
  tui.requestRender();
}

// ---------- agent 事件 ----------

function handleAgentEvent(e: AgentEvent) {
  switch (e.type) {
    case "message_start": {
      if (e.message.role !== "assistant") break;
      removeLoader();
      msgStartAt = Date.now();
      streamingMsg = new AssistantMessageComponent(e.message as AssistantMessage, false, getMarkdownTheme());
      streaming = new BarComponent(streamingMsg, fg.accent);
      chat.addChild(streaming);
      tui.requestRender();
      break;
    }
    case "message_update": {
      if (e.message.role !== "assistant" || !streamingMsg) break;
      streamingMsg.updateContent(e.message as AssistantMessage, true);
      tui.requestRender();
      break;
    }
    case "message_end": {
      if (e.message.role !== "assistant") break;
      const msg = e.message as AssistantMessage;
      lastTurnFailed = false;
      const visible =
        msg.content.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim())) ||
        msg.content.some((c) => c.type === "toolCall");
      // 思维链结束后自动收起成一行标签（点击可展开）；生成中保持展开流出
      const hasThinking = msg.content.some((c) => c.type === "thinking" && c.thinking.trim());
      const elapsedS = msgStartAt !== null ? Math.max(1, Math.round((Date.now() - msgStartAt) / 1000)) : 0;
      msgStartAt = null;
      if (hasThinking && streamingMsg) {
        streamingMsg.setHiddenThinkingLabel(`✦ 已思考 ${elapsedS}s`);
        streamingMsg.setHideThinkingBlock(true);
      }
      // abort/error 时 pi 组件条内自带状态行（Request aborted / 错误信息），这里不再重复打
      if (msg.stopReason === "error") {
        sawError = true;
        lastTurnFailed = true;
        addLine(fg.error(`✗ API 错误：${msg.errorMessage ?? "未知"}`));
      } else if (msg.stopReason === "aborted") {
        sawAbort = true;
        agent.clearSteeringQueue(); // 中断时丢掉还没发出去的排队消息
      } else if (!visible && streaming) {
        // 干净结束却没有任何内容：整块移除空条，不留孤零零的 ▌
        chat.removeChild(streaming);
        streaming = null;
        streamingMsg = null;
        tui.requestRender();
        break;
      }
      streamingMsg?.updateContent(msg, false);
      streaming = null;
      streamingMsg = null;
      statusBar.addUsage(msg.usage); // 累计进状态栏，不再逐条打 ⤷ 行
      statusBar.setContext(Number(msg.usage?.input ?? 0), Number(agent.state.model.contextWindow ?? 0));
      addLine("", 0);
      tui.requestRender();
      break;
    }
    case "tool_execution_start": {
      const comp = new ToolCallComponent(e.toolName);
      toolCalls.set(e.toolCallId, comp);
      chat.addChild(comp);
      tui.requestRender();
      break;
    }
    case "tool_execution_update": {
      const comp = toolCalls.get(e.toolCallId);
      const summary = e.partialResult?.details?.summary;
      if (comp && typeof summary === "string") comp.setUpdate(summary);
      break;
    }
    case "tool_execution_end": {
      const comp = toolCalls.get(e.toolCallId);
      toolCalls.delete(e.toolCallId);
      const details = e.result?.details;
      if (e.toolName === "judge" && !e.isError && isJudgeDetails(details)) {
        // 整块替换运行中行，卡片成为唯一记录
        if (comp) chat.removeChild(comp);
        appendJudgeCard(details as JudgeDetails, extractText(e.result?.content, "\n"));
      } else {
        const summary =
          typeof details?.summary === "string" ? details.summary : e.isError ? "失败" : "完成";
        // 失败时把真实报错原因（工具返回的文本）带出来，不然只剩一句「失败」没法排查
        const detail = e.isError ? extractText(e.result?.content, "\n") || undefined : undefined;
        comp?.finish(
          `  ${e.isError ? fg.error("✗") : fg.success("✓")} ${fg.text(e.toolName)} ${fg.dim(summary)}`,
          detail,
        );
      }
      tui.requestRender();
      break;
    }
    case "agent_end": {
      removeLoader();
      statusBar.stopStreaming();
      const err = agent.state.errorMessage;
      if (!sawError && !sawAbort && err) {
        lastTurnFailed = true;
        addLine(fg.error(`✗ ${err}`));
      }
      // 瞬时错误自动重试（退避 ≤2 次）；非瞬时（如 401）不自动，留给 /retry
      if (lastTurnFailed && autoRetries < 2) {
        const lastAssistant = [...agent.state.messages].reverse().find((m: any) => m?.role === "assistant") as any;
        const errMsg = `${err ?? ""} ${lastAssistant?.errorMessage ?? ""}`;
        if (TRANSIENT_RE.test(errMsg)) {
          autoRetries++;
          const delay = 1500 * autoRetries;
          const agentAtSchedule = agent;
          addLine(fg.dim(`⟳ 看起来是瞬时错误，${delay / 1000}s 后自动重试（${autoRetries}/2）`));
          setTimeout(() => {
            if (agent !== agentAtSchedule) return; // 期间 /new //resume 换了会话，放弃这次自动重试
            rerunLastQuestion(`自动重试 ${autoRetries}/2`);
          }, delay);
        }
      }
      // 上下文超阈值：空闲时自动压缩
      const pct = statusBar.ctxPct;
      if (!sawAbort && !lastTurnFailed && !compacting && AUTOCOMPACT_THRESHOLD > 0 && pct >= AUTOCOMPACT_THRESHOLD) {
        addLine(fg.warning(`▤ 上下文已用 ${(pct * 100).toFixed(0)}%，自动压缩（OI_PI_AUTOCOMPACT 可调/关闭）`));
        void compactSession();
      }
      saveCurrent(); // 每轮结束落盘
      tui.requestRender();
      break;
    }
  }
}

// ---------- 重试 / 回退 ----------

// 瞬时错误特征（限流/超时/网络抖动才自动重试，401 之类交给 /retry 手动）
// "Connection error." 是 openai SDK 对一切连接问题的笼统包装，也视作瞬时
const TRANSIENT_RE = /rate.?limit|429\b|5\d\d\b|timeout|timed out|econn\w*|fetch failed|network|socket|connection error/i;

/** 把消息截断到最后一条用户提问处（含该提问） */
function truncateToLastUser(): boolean {
  const msgs = agent.state.messages;
  let lastUser = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role === "user") {
      lastUser = i;
      break;
    }
  }
  if (lastUser === -1) return false;
  agent.state.messages = msgs.slice(0, lastUser + 1);
  return true;
}

/** 回退失败轮并从提问处重跑；/retry 与瞬时错误自动重试共用 */
function rerunLastQuestion(reason: string): void {
  if (agent.state.isStreaming || compacting) {
    addLine(fg.warning("稍等，当前有事在进行"));
    return;
  }
  if (!truncateToLastUser()) {
    addLine(fg.warning("没有可重试的提问"));
    return;
  }
  sawError = false;
  sawAbort = false;
  lastTurnFailed = false;
  addLine(fg.dim(`↻ ${reason}：已回退到你的提问，重新生成中…`));
  statusBar.startStreaming();
  agent.continue().catch((err: unknown) => {
    statusBar.stopStreaming();
    lastTurnFailed = true;
    addLine(fg.error(`✗ ${err instanceof Error ? err.message : String(err)}`));
  });
  tui.requestRender();
}

/** 按当前消息列表重算状态栏（累计用量 + ctx%），/resume 与 /rewind 共用 */
function syncStatusFromMessages(messages: any[]): void {
  statusBar.reset();
  statusBar.setModel(agent.state.model.name);
  let lastIn = 0;
  for (const m of messages) {
    if (m?.role === "assistant") {
      statusBar.addUsage(m.usage);
      lastIn = Number((m as any)?.usage?.input ?? lastIn);
    }
  }
  statusBar.setContext(lastIn, Number(agent.state.model.contextWindow ?? 0));
}

// ---------- 上下文压缩 ----------

const COMPACT_SYSTEM = `你是对话摘要器。把用户与 AI 信奥教练的对话压缩为一份要点摘要，必须保留：
- 正在讨论的题目（题号、题面关键约束、数据范围）
- 学生的思路与已写的代码要点
- 教练给出的方向性提示与结论
- 知识点掌握情况的变化
- 未解决的问题与下一步
直接输出摘要正文，不要寒暄，不要评论。`;

async function compactSession(keep = 2): Promise<void> {
  if (compacting) return;
  const msgs = agent.state.messages;
  if (msgs.length <= keep + 1) {
    addLine(fg.warning("对话太短，无需压缩"));
    return;
  }
  compacting = true;
  try {
    const lines: string[] = [];
    for (const m of msgs) {
      if (m?.role === "user") {
        lines.push(`[用户] ${extractText(m.content)}`);
      } else if (m?.role === "assistant") {
        const text = (m.content ?? [])
          .filter((c: any) => c?.type === "text")
          .map((c: any) => c.text)
          .join("\n");
        if (text.trim()) lines.push(`[教练] ${text}`);
        const tools = (m.content ?? []).filter((c: any) => c?.type === "toolCall").map((c: any) => c?.name);
        if (tools.length) lines.push(`[教练调用工具] ${tools.join("、")}`);
      } else if (m?.role === "toolResult") {
        lines.push(`[工具结果] ${m.toolName ?? "tool"}: ${extractText(m.content).slice(0, 200)}`);
      }
    }
    let transcript = lines.join("\n\n");
    if (transcript.length > 24000) transcript = transcript.slice(transcript.length - 24000); // 保尾：近期内容更重要

    addLine(fg.dim("▤ 正在压缩对话…"));
    const summarizer = createOiAgent(runtime, {
      systemPrompt: COMPACT_SYSTEM,
      tools: [],
      thinkingLevel: "off",
      confirmDelete: async () => false,
    });
    await summarizer.prompt(transcript);
    const lastMsg = summarizer.state.messages.at(-1);
    const summary =
      lastMsg?.role === "assistant"
        ? (lastMsg.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n").trim()
        : "";
    if (!summary) throw new Error("摘要为空");

    const kept = msgs.slice(-keep);
    agent.state.messages = [
      { role: "user", content: `（此前对话的摘要，供参考）\n${summary}`, timestamp: Date.now() },
      ...kept,
    ];
    const lastAssistant = [...kept].reverse().find((m: any) => m?.role === "assistant") as any;
    statusBar.setContext(Number(lastAssistant?.usage?.input ?? 0), Number(agent.state.model.contextWindow ?? 0));

    chat.clear();
    addHeader();
    renderHistory(agent.state.messages);
    saveCurrent();
    addLine(fg.dim(`▤ 已压缩：${msgs.length} 条消息 → 摘要 + 最近 ${kept.length} 条`));
    tui.requestRender();
  } catch (err: unknown) {
    addLine(fg.error(`✗ 压缩失败：${err instanceof Error ? err.message : String(err)}`));
  } finally {
    compacting = false;
  }
}

// ---------- 组装 ----------

const editor = new Editor(
  tui,
  {
    borderColor: (s) => fg.border(s),
    selectList: getSelectListTheme(),
  },
  { autocompleteMaxVisible: 8 },
);
editor.onSubmit = onSubmit;
editor.setAutocompleteProvider?.(new SlashAutocomplete());
for (const h of loadPromptHistory()) editor.addToHistory(h);

tui.addChild(chat);
tui.addChild(editor);
tui.addChild(statusBar);
tui.setFocus(editor);

// raw mode 下 Ctrl+C 不产生 SIGINT，统一在这里拦截：选择器开着先关闭（视作取消），
// 生成中 Ctrl+C/Esc 中断（Esc 在 / 补全时让路给编辑器），空闲时退出
tui.addInputListener((data) => {
  if (matchesKey(data, "escape") && agent.state.isStreaming && !openList && !editor.getText().startsWith("/")) {
    agent.abort();
    return { consume: true };
  }
  if (!matchesKey(data, "ctrl+c")) return;
  if (openList) {
    closeSelector(true);
    return;
  }
  if (agent.state.isStreaming) {
    agent.abort();
    return;
  }
  saveCurrent();
  tui.stop();
  process.exit(0);
});

statusBar.setModel(agent.state.model.name);
addHeader();
setTerminalTitle("信奥助教");
if (mcpTools.length > 0) {
  addLine(fg.muted(`已接入 MCP 工具：${mcpTools.map((t) => t.name).join("、")}`), 1);
}
tui.start();

// 启动参数：--model provider/id 临时换模型；其余词拼接为初始问题
const rawArgv = process.argv.slice(2);
const modelFlag = rawArgv.indexOf("--model");
if (modelFlag !== -1 && rawArgv[modelFlag + 1]) {
  switchModel(rawArgv[modelFlag + 1]!);
}
const initialPrompt = rawArgv
  .filter((_, i) => i !== modelFlag && i !== modelFlag + 1)
  .join(" ")
  .trim();
if (initialPrompt) onSubmit(initialPrompt);
