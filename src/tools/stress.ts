// stress 工具：对拍——暴力解 vs 待验证解，随机数据自动找反例
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { GEN_OUTPUT_BYTES, clip, compileCpp, normalize, run, tail } from "./exec.js";

const MAX_ROUNDS = 1000;
const DEFAULT_ROUNDS = 100;
const MAX_TIME_MS = 10_000;
const DEFAULT_TIME_MS = 1_000;

const Parameters = Type.Object({
  solution_code: Type.String({ description: "待验证的解法 C++ 源码" }),
  brute_code: Type.String({ description: "暴力解 C++ 源码（结论可信的参照实现，可以慢，但必须对）" }),
  gen_code: Type.String({
    description:
      "数据生成器 C++ 源码：编译后以 ./gen <seed> 运行，向 stdout 输出一组完整的测试数据。" +
      "数据范围看题目，严格按题面限制生成，并覆盖边界（最小值、最大值、极端结构）",
  }),
  rounds: Type.Optional(Type.Number({ description: `对拍轮数，默认 ${DEFAULT_ROUNDS}，上限 ${MAX_ROUNDS}` })),
  timeLimitMs: Type.Optional(Type.Number({ description: `解法单组时限毫秒，默认 ${DEFAULT_TIME_MS}` })),
});

type StressParams = Static<typeof Parameters>;

export interface StressDetails {
  summary: string;
  found: boolean;
  roundsRun: number;
}

export const stressTool: AgentTool<typeof Parameters, StressDetails> = {
  name: "stress",
  label: "对拍",
  description:
    "对拍验证解法正确性：编译「待验证解法 + 暴力解 + 数据生成器」，按 seed 递增批量生成随机数据，" +
    "比对两者输出，找到第一个反例立即返回（含完整输入与双方输出）；数据范围必须看题目、按题面限制生成。" +
    "也可用于验证你自己写的参考解法。",
  parameters: Parameters,
  executionMode: "sequential",
  async execute(_toolCallId, params: StressParams, signal?, onUpdate?: AgentToolUpdateCallback<StressDetails>): Promise<AgentToolResult<StressDetails>> {
    const rounds = Math.min(Math.max(Math.floor(params.rounds ?? DEFAULT_ROUNDS), 1), MAX_ROUNDS);
    const timeLimit = Math.min(Math.max(params.timeLimitMs ?? DEFAULT_TIME_MS, 1), MAX_TIME_MS);
    const bruteLimit = Math.min(timeLimit * 5, 30_000);
    const report: string[] = [];
    const finish = (details: StressDetails): AgentToolResult<StressDetails> => ({
      content: [{ type: "text", text: report.join("\n") }],
      details,
    });

    const dir = await mkdtemp(join(tmpdir(), "oi-pi-stress-"));
    try {
      const progs: Array<{ label: string; code: string; out: string; source: string }> = [
        { label: "解法", code: params.solution_code, out: "sol", source: "sol.cpp" },
        { label: "暴力解", code: params.brute_code, out: "brute", source: "brute.cpp" },
        { label: "生成器", code: params.gen_code, out: "gen", source: "gen.cpp" },
      ];
      for (const p of progs) {
        const c = await compileCpp(dir, p.code, { sourceName: p.source, outName: p.out, signal });
        if (!c.ok) {
          report.push(`${p.label}编译失败：\n${tail(c.stderr)}`);
          return finish({ summary: `${p.label}编译失败`, found: false, roundsRun: 0 });
        }
      }

      const counterexample = (kind: string, round: number, input: string, sol: { stdout: string; stderr: string }, brute?: { stdout: string }): StressDetails => {
        report.push(
          `第 ${round} 组找到反例（${kind}）：\n` +
          `--- 输入 ---\n${clip(input, 1500)}\n` +
          `--- 解法输出 ---\n${clip(sol.stdout, 800)}${sol.stderr.trim() ? `\n--- 解法 stderr ---\n${clip(sol.stderr, 300)}` : ""}` +
          (brute ? `\n--- 暴力输出 ---\n${clip(brute.stdout, 800)}` : ""),
        );
        return { summary: `第 ${round} 组找到反例（${kind}）`, found: true, roundsRun: round };
      };

      for (let i = 1; i <= rounds; i++) {
        if (signal?.aborted) throw new Error("aborted");
        const genR = await run(join(dir, "gen"), { args: [String(i)], timeoutMs: 5_000, cwd: dir, signal, maxOutputBytes: GEN_OUTPUT_BYTES });
        if (genR.timedOut || genR.code !== 0) {
          report.push(`生成器在第 ${i} 组失败（${genR.timedOut ? "超时" : `退出码 ${genR.code}`}）：\n${tail(genR.stderr)}`);
          return finish({ summary: `生成器失败（第 ${i} 组）`, found: false, roundsRun: i - 1 });
        }
        const input = genR.stdout;

        const solR = await run(join(dir, "sol"), { input, timeoutMs: timeLimit, cwd: dir, signal });
        if (solR.timedOut) return finish(counterexample("TLE", i, input, solR));
        if (solR.outputCapped) return finish(counterexample("输出超限", i, input, solR));
        if (solR.code !== 0) return finish(counterexample("RE", i, input, solR));

        const bruteR = await run(join(dir, "brute"), { input, timeoutMs: bruteLimit, cwd: dir, signal });
        if (bruteR.timedOut || bruteR.code !== 0) {
          report.push(
            `暴力解在第 ${i} 组失败（${bruteR.timedOut ? "超时" : `退出码 ${bruteR.code}`}），可能是暴力太慢或生成器超出了题面数据范围：\n` +
            `--- 输入 ---\n${clip(input, 1000)}`,
          );
          return finish({ summary: `暴力解失败（第 ${i} 组）`, found: false, roundsRun: i - 1 });
        }
        if (normalize(solR.stdout) !== normalize(bruteR.stdout)) {
          return finish(counterexample("WA", i, input, solR, bruteR));
        }
        if (i % 10 === 0 || i === rounds) {
          onUpdate?.({ content: [], details: { summary: `已对拍 ${i}/${rounds} 组`, found: false, roundsRun: i } });
        }
      }

      report.push(`对拍 ${rounds} 组全部一致，未发现反例（生成器 seed 1~${rounds}）。`);
      return finish({ summary: `${rounds} 组全部一致`, found: false, roundsRun: rounds });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  },
};
