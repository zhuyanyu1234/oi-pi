// 组件冒烟（pnpm smoke:ui）：渲染与补全逻辑验证，不进 TUI 循环、不需要模型 API
import { Text } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { JudgeCardComponent, judgeAllPassed, judgeFoldedLine, type JudgeDetails } from "./components/judge-card.js";
import { StatusBar } from "./components/status-bar.js";
import { BarComponent, SlashAutocomplete } from "./components/chat-widgets.js";

const allAC: JudgeDetails = {
  summary: "3/3 通过 · 最长 12ms",
  passed: 3,
  total: 3,
  tests: [
    { name: "样例1", verdict: "AC", timeMs: 5 },
    { name: "样例2", verdict: "AC", timeMs: 12 },
    { name: "测试 3", verdict: "AC", timeMs: 8 },
  ],
};

const withWA: JudgeDetails = {
  summary: "1/2 通过 · 最长 34ms",
  passed: 1,
  total: 2,
  tests: [
    { name: "样例1", verdict: "AC", timeMs: 5 },
    { name: "样例2", verdict: "WA", timeMs: 34, note: "期望 \"3\" · 实际 \"4\"" },
    { name: "测试 3", verdict: "TLE", timeMs: 1000, note: "超过时限 1000ms" },
  ],
};

const ce: JudgeDetails = { summary: "编译失败", passed: 0, total: 2, tests: [] };

console.log("=== 全 AC 折叠 ===");
console.log(judgeFoldedLine(allAC));
console.log("judgeAllPassed:", judgeAllPassed(allAC));

console.log("\n=== WA/TLE 卡片（80 列）===");
for (const l of new JudgeCardComponent(withWA).render(80)) {
  console.log(JSON.stringify(l), "vw=", visibleWidth(l));
}

console.log("\n=== CE 卡片（60 列）===");
for (const l of new JudgeCardComponent(ce, "编译失败：\nsol.cpp: In function 'int main()':\nsol.cpp:5:12: error: 'x' was not declared\nmore lines here").render(60)) {
  console.log(l);
}

console.log("\n=== 状态栏 ===");
const sb = new StatusBar(() => {});
sb.setModel("glm-4.7");
sb.addUsage({ input: 15230, output: 842, cost: { total: 0.01234 } });
sb.startStreaming();
for (const l of sb.render(80)) console.log(JSON.stringify(l), "vw=", visibleWidth(l));
sb.stopStreaming();
sb.reset();
for (const l of sb.render(80)) console.log(JSON.stringify(l));

console.log("\n=== 色条 ===");
const bar = new BarComponent(new Text("hello 世界", 0, 0), (s) => `\x1b[38;2;148;226;213m${s}\x1b[0m`);
for (const l of bar.render(40)) console.log(JSON.stringify(l));

console.log("\n=== 补全 ===");
const ac = new SlashAutocomplete();
const sig = { signal: new AbortController().signal, force: false };
for (const token of ["/", "/n", "/ne", "/new", "hi /mo", "你好/new"]) {
  const r = await ac.getSuggestions([token], 0, token.length, sig);
  console.log(JSON.stringify(token), "→", r ? r.items.map((i) => i.value).join(",") : "null");
}
const applied = ac.applyCompletion(["/r"], 0, 2, { value: "/resume", label: "/resume" }, "/r");
console.log("apply /r →", JSON.stringify(applied));
