// 冒烟测试：不走 TUI，直接验证 模型目录 → Agent → API 全链路
import { createModelRuntime, createOiAgent } from "./session.js";

const runtime = await createModelRuntime();
const agent = createOiAgent(runtime);

agent.subscribe((e) => {
  if (e.type === "message_update" && e.message.role === "assistant") {
    const ev = e.assistantMessageEvent;
    if (ev.type === "text_delta") process.stdout.write(ev.delta);
  }
  // API 报错不抛异常，只在 message_end 里带 stopReason: "error"，必须自己打出来
  if (e.type === "message_end" && e.message.role === "assistant") {
    const msg = e.message;
    if (msg.stopReason === "error")
      process.stderr.write(`\n[API error] ${msg.errorMessage}\n`);
  }
});

await agent.prompt("用一句话介绍你自己");
console.log();
