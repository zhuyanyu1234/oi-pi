// 会话持久化：对话记录存 ~/.oi-pi/agent/sessions/oi-pi-*.json，/resume 可恢复
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_DIR } from "./config.js";

const SESSIONS_DIR = join(AGENT_DIR, "sessions");

export interface SessionModel {
  provider: string;
  id: string;
}

export interface SessionMeta {
  id: string;
  title: string;
  savedAt: string;
  messageCount: number;
  model: SessionModel | undefined;
}

export function newSessionId(): string {
  return `oi-pi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function firstUserText(messages: any[]): string {
  for (const m of messages) {
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    const parts = Array.isArray(m.content) ? m.content : [];
    const text = parts.filter((p: any) => p?.type === "text").map((p: any) => p.text).join(" ");
    if (text) return text;
  }
  return "(无用户消息)";
}

function clipTitle(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= 40 ? t : `${t.slice(0, 40)}…`;
}

export function saveSession(id: string, data: { model: SessionModel; messages: unknown[] }): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const stored = { version: 1, savedAt: new Date().toISOString(), model: data.model, messages: data.messages };
  writeFileSync(join(SESSIONS_DIR, `${id}.json`), JSON.stringify(stored));
}

export function listSessions(): SessionMeta[] {
  let files: string[] = [];
  try {
    files = readdirSync(SESSIONS_DIR).filter((f) => f.startsWith("oi-pi-") && f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: SessionMeta[] = [];
  for (const f of files) {
    try {
      const parsed = JSON.parse(readFileSync(join(SESSIONS_DIR, f), "utf8"));
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      out.push({
        id: f.slice(0, -".json".length),
        title: firstUserText(messages),
        savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : "",
        messageCount: messages.length,
        model: parsed.model,
      });
    } catch {
      // 损坏的会话文件直接跳过
    }
  }
  return out.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
}

export function loadSession(id: string): { model: SessionModel | undefined; messages: any[] } {
  const parsed = JSON.parse(readFileSync(join(SESSIONS_DIR, `${id}.json`), "utf8"));
  return { model: parsed.model, messages: Array.isArray(parsed.messages) ? parsed.messages : [] };
}
