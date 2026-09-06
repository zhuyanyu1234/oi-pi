// complexity 工具：倍增数据规模实测耗时，验证复杂度判断
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { GEN_OUTPUT_BYTES, compileCpp, run, tail } from "./exec.js";

const MAX_ROUNDS = 6;
const MAX_TIME_MS = 30_000;
const DEFAULT_TIME_MS = 5_000;

const Parameters = Type.Object({
  code: Type.String({ description: "待测复杂度的 C++ 解法源码" }),
  gen_code: Type.String({
    description:
      "数据生成器 C++ 源码：编译后以 ./gen <n> <seed> 运行，向 stdout 输出规模为 n 的合法测试数据。" +
      "数据的合法性与格式必须看题目、符合题面要求",
  }),
  baseN: Type.Number({
    description: "起始数据规模 n。按题面数据范围选（如题面 n≤1e5 就从 1e5 附近开始），之后逐轮倍增",
  }),
  rounds: Type.Optional(Type.Number({ description: `倍增轮数（n, 2n, 4n, ...），默认 4，上限 ${MAX_ROUNDS}` })),
  timeLimitMs: Type.Optional(Type.Number({ description: `单轮运行时限毫秒，默认 ${DEFAULT_TIME_MS}` })),
});

type ComplexityParams = Static<typeof Parameters>;

export interface ComplexityDetails {
  summary: string;
  measurements: Array<{ n: number; timeMs: number; timedOut: boolean }>;
}

export const complexityTool: AgentTool<typeof Parameters, ComplexityDetails> = {
  name: "complexity",
  label: "复杂度实测",
  description:
    "倍增实测复杂度：按 n, 2n, 4n, ... 生成数据并运行解法，返回各规模的实测耗时与相邻比值，" +
    "用于验证代码是不是预期的复杂度（比值≈2 是 O(n)/O(n log n)，≈4 是 O(n²)，≈8 是 O(n³)）。" +
    "起始规模按题面数据范围选，生成器产生的数据必须符合题面格式与限制。",
  parameters: Parameters,
  executionMode: "sequential",
  async execute(_toolCallId, params: ComplexityParams, signal?, onUpdate?: AgentToolUpdateCallback<ComplexityDetails>): Promise<AgentToolResult<ComplexityDetails>> {
    const rounds = Math.min(Math.max(Math.floor(params.rounds ?? 4), 2), MAX_ROUNDS);
    const timeLimit = Math.min(Math.max(params.timeLimitMs ?? DEFAULT_TIME_MS, 1), MAX_TIME_MS);
    const baseN = Math.max(Math.floor(params.baseN), 1);
    const report: string[] = [];
    const finish = (details: ComplexityDetails): AgentToolResult<ComplexityDetails> => ({
      content: [{ type: "text", text: report.join("\n") }],
      details,
    });

    const dir = await mkdtemp(join(tmpdir(), "oi-pi-cplx-"));
    try {
      for (const p of [
        { label: "解法", code: params.code, source: "sol.cpp", out: "sol" },
        { label: "生成器", code: params.gen_code, source: "gen.cpp", out: "gen" },
      ]) {
        const c = await compileCpp(dir, p.code, { sourceName: p.source, outName: p.out, signal });
        if (!c.ok) {
          report.push(`${p.label}编译失败：\n${tail(c.stderr)}`);
          return finish({ summary: `${p.label}编译失败`, measurements: [] });
        }
      }

      const measurements: ComplexityDetails["measurements"] = [];
      for (let i = 0; i < rounds; i++) {
        if (signal?.aborted) throw new Error("aborted");
        const n = baseN * 2 ** i;
        const genR = await run(join(dir, "gen"), { args: [String(n), String(i + 1)], timeoutMs: 15_000, cwd: dir, signal, maxOutputBytes: GEN_OUTPUT_BYTES });
        if (genR.timedOut || genR.code !== 0) {
          report.push(`生成器在 n=${n} 失败（${genR.timedOut ? "超时" : `退出码 ${genR.code}`}）：\n${tail(genR.stderr)}`);
          return finish({ summary: `生成器失败（n=${n}）`, measurements });
        }
        const solR = await run(join(dir, "sol"), { input: genR.stdout, timeoutMs: timeLimit, cwd: dir, signal });
        const m = { n, timeMs: Math.round(solR.timeMs * 10) / 10, timedOut: solR.timedOut };
        measurements.push(m);
        const note = solR.timedOut ? ` 超时(>${timeLimit}ms)` : solR.code !== 0 ? ` RE(退出码 ${solR.code})` : "";
        report.push(`n=${n} → ${m.timeMs}ms${note}`);
        onUpdate?.({ content: [], details: { summary: `n=${n} → ${m.timeMs}ms${note}`, measurements: [...measurements] } });
      }

      const ok = measurements.filter((m) => !m.timedOut);
      if (ok.length >= 2) {
        const ratios = ok.slice(1).map((m, i) => {
          const prev = ok[i]!;
          return prev.timeMs > 0 ? (m.timeMs / prev.timeMs).toFixed(1) : "?";
        });
        report.push(`相邻比值（t(2n)/t(n)）：${ratios.join(", ")}`);
        report.push("参考：比值≈2 → O(n)/O(n log n)；≈4 → O(n²)；≈8 → O(n³)。仅实测参考，请结合理论分析。");
      }
      const first = measurements[0];
      const last = measurements.at(-1)!;
      return finish({
        summary: `n=${first?.n}→${last.n} 实测 ${last.timedOut ? "超时" : `${last.timeMs}ms`}`,
        measurements,
      });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  },
};
