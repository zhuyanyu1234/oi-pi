// oi-pi 自研 TUI：pi-tui 组件库 + pi-agent-core Agent 直接组装，不使用 pi 的 InteractiveMode
import {
  Container,
  Editor,
  Loader,
  matchesKey,
  ProcessTerminal,
  Text,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import {
  AssistantMessageComponent,
  getMarkdownTheme,
  getSelectListTheme,
  initTheme,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";
import { createModelRuntime, createOiAgent, resolveModel } from "./session.js";
import { bold, fg } from "./theme.js";
import { listSessions, loadSession, newSessionId, saveSession } from "./session-store.js";

initTheme("dark");

const runtime = await createModelRuntime();

const tui: TUI = new TuiMainScreen(new ProcessTerminal());
const chat = new Container();

const addLine = (text: string, paddingX = 1) => {
  chat.addChild(new Text(text, paddingX, 0));
  tui.requestRender();
};

function addHeader() {
  addLine(bold(fg.accent("oi-pi")) + fg.dim(" · 信奥助教"), 1);
  addLine(fg.dim(`${model.name} · /help 查看命令 · Ctrl+C 中断生成，空闲时退出`), 1);
  addLine("", 0);
}

function printHelp() {
  const lines = [
    "/new           新对话（自动保存当前对话，提示词改动此时生效）",
    "/resume [n]    查看历史会话 / 恢复第 n 个",
    "/model [n|id]  查看可用模型 / 切换模型",
    "/exit          退出",
    "/help          显示本帮助",
  ];
  for (const l of lines) addLine(fg.dim(l));
}

// agent 可整体重建（/new、/resume 时重载提示词与模型），事件处理器绑定在 let 变量上
let agent: Agent = buildAgent();
let sessionId = newSessionId();
let streaming: AssistantMessageComponent | null = null;
let loader: Loader | null = null;
let sawError = false;

function buildAgent(): Agent {
  const a = createOiAgent(runtime);
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

function printModelList() {
  const list = availableModels();
  if (list.length === 0) {
    addLine(fg.warning("没有可用模型，请检查 ~/.oi-pi/agent/models.json"));
    return;
  }
  for (const [i, m] of list.entries()) {
    const current = m.provider === agent.state.model.provider && m.id === agent.state.model.id;
    addLine(fg[current ? "success" : "dim"](`${i + 1}. ${m.provider}/${m.id}${current ? "  ← 当前" : ""}`));
  }
  addLine(fg.dim("/model <序号或 provider/id> 切换"));
}

function switchModel(arg: string) {
  const list = availableModels();
  const index = Number(arg);
  const target = Number.isInteger(index) && index >= 1 && index <= list.length
    ? list[index - 1]
    : list.find((m) => `${m.provider}/${m.id}` === arg || m.id === arg);
  if (!target) {
    addLine(fg.warning(`未找到模型「${arg}」，/model 查看列表`));
    return;
  }
  agent.state.model = target;
  saveCurrent();
  addLine(fg.dim(`已切换到 ${target.name}（${target.provider}/${target.id}）`));
}

function printResumeList() {
  const sessions = listSessions();
  if (sessions.length === 0) {
    addLine(fg.dim("还没有历史会话"));
    return;
  }
  sessions.slice(0, 10).forEach((s, i) => {
    const when = s.savedAt.slice(0, 16).replace("T", " ");
    addLine(`${fg.accent(`${i + 1}.`)} ${s.title} ${fg.dim(`· ${when} · ${s.messageCount} 条`)}`);
  });
  addLine(fg.dim("/resume <序号> 恢复对应会话"));
}

function resumeSession(arg: string) {
  const sessions = listSessions();
  const index = Number(arg);
  const meta = Number.isInteger(index) && index >= 1 && index <= sessions.length ? sessions[index - 1] : undefined;
  if (!meta) {
    addLine(fg.warning("用法：/resume <序号>（/resume 查看列表）"));
    return;
  }
  let loaded;
  try {
    loaded = loadSession(meta.id);
  } catch {
    addLine(fg.error(`会话文件损坏：${meta.id}`));
    return;
  }
  agent = buildAgent(); // 顺带重载提示词
  sessionId = meta.id;
  const saved = loaded.model ? runtime.getModel(loaded.model.provider, loaded.model.id) : undefined;
  if (saved) agent.state.model = saved;
  agent.state.messages = loaded.messages;

  chat.clear();
  addHeader();
  for (const msg of loaded.messages) {
    if (msg?.role === "user") {
      const text = typeof msg.content === "string"
        ? msg.content
        : (Array.isArray(msg.content) ? msg.content : [])
            .filter((p: any) => p?.type === "text")
            .map((p: any) => p.text)
            .join(" ");
      chat.addChild(new UserMessageComponent(text, getMarkdownTheme()));
    } else if (msg?.role === "assistant") {
      chat.addChild(new AssistantMessageComponent(msg as AssistantMessage, false, getMarkdownTheme()));
    } else if (msg?.role === "toolResult") {
      addLine(fg.dim("  ⏺ 工具调用结果"), 0);
    }
  }
  addLine(fg.dim(`已恢复 ${loaded.messages.length} 条消息（模型：${agent.state.model.name}）`));
  addLine("", 0);
  tui.requestRender();
}

function onSubmit(text: string) {
  const input = text.trim();
  if (!input) return;

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
      else printModelList();
    } else if (cmd === "/new") {
      if (agent.state.isStreaming) {
        addLine(fg.warning("正在生成中，请等当前回答完成或 Ctrl+C 中断后再 /new"));
        return;
      }
      saveCurrent();
      sessionId = newSessionId();
      agent = buildAgent(); // 重建 = 重读 prompts/*.md，hint/提示词改动此时生效
      chat.clear();
      addHeader();
    } else if (cmd === "/resume") {
      if (agent.state.isStreaming) {
        addLine(fg.warning("正在生成中，请等当前回答完成或 Ctrl+C 中断后再 /resume"));
        return;
      }
      if (arg) resumeSession(arg);
      else printResumeList();
    } else if (cmd === "/help") {
      printHelp();
    } else {
      addLine(fg.warning(`未知命令 ${cmd}，/help 查看可用命令`));
    }
    return;
  }

  if (agent.state.isStreaming) {
    addLine(fg.warning("正在生成中，请等当前回答完成（Ctrl+C 可中断）"));
    return;
  }

  sawError = false;
  chat.addChild(new UserMessageComponent(input, getMarkdownTheme()));
  loader = new Loader(tui, (s) => fg.accent(s), (s) => fg.muted(s), "思考中…");
  chat.addChild(loader);
  agent.prompt(input).catch((err: unknown) => {
    removeLoader();
    const message = err instanceof Error ? err.message : String(err);
    addLine(fg.error(`✗ ${message}`));
  });
  tui.requestRender();
}

function handleAgentEvent(e: AgentEvent) {
  switch (e.type) {
    case "message_start": {
      if (e.message.role !== "assistant") break;
      removeLoader();
      streaming = new AssistantMessageComponent(e.message as AssistantMessage, false, getMarkdownTheme());
      chat.addChild(streaming);
      tui.requestRender();
      break;
    }
    case "message_update": {
      if (e.message.role !== "assistant" || !streaming) break;
      streaming.updateContent(e.message as AssistantMessage, true);
      tui.requestRender();
      break;
    }
    case "message_end": {
      if (e.message.role !== "assistant") break;
      const msg = e.message as AssistantMessage;
      streaming?.updateContent(msg, false);
      streaming = null;
      if (msg.stopReason === "error") {
        sawError = true;
        addLine(fg.error(`✗ API 错误：${msg.errorMessage ?? "未知"}`));
      } else if (msg.stopReason === "aborted") {
        addLine(fg.warning("⏹ 已中断"));
      } else if (msg.usage) {
        const { input, output, cost } = msg.usage;
        addLine(fg.dim(`  ⤷ ${input + output} tok · $${cost.total.toFixed(4)}`));
      }
      addLine("", 0);
      tui.requestRender();
      break;
    }
    case "tool_execution_update": {
      const summary = e.partialResult?.details?.summary;
      if (typeof summary === "string") addLine(fg.dim(`  ├ ${e.toolName} ${summary}`));
      break;
    }
    case "tool_execution_start": {
      addLine(fg.accent(`⏺ ${e.toolName} 运行中…`));
      break;
    }
    case "tool_execution_end": {
      const summary =
        typeof e.result?.details?.summary === "string"
          ? e.result.details.summary
          : e.isError
            ? "失败"
            : "完成";
      addLine(fg[e.isError ? "error" : "success"](`⏺ ${e.toolName} ${summary}`));
      break;
    }
    case "agent_end": {
      removeLoader();
      const err = agent.state.errorMessage;
      if (!sawError && err) addLine(fg.error(`✗ ${err}`));
      saveCurrent(); // 每轮结束落盘
      tui.requestRender();
      break;
    }
  }
}

const editor = new Editor(tui, {
  borderColor: (s) => fg.border(s),
  selectList: getSelectListTheme(),
});
editor.onSubmit = onSubmit;

tui.addChild(chat);
tui.addChild(editor);
tui.setFocus(editor);

// raw mode 下 Ctrl+C 不产生 SIGINT，统一在这里拦截：生成中中断，空闲时退出
tui.addInputListener((data) => {
  if (!matchesKey(data, "ctrl+c")) return;
  if (agent.state.isStreaming) {
    agent.abort();
    return;
  }
  saveCurrent();
  tui.stop();
  process.exit(0);
});

const model = resolveModel(runtime);
addHeader();
tui.start();
