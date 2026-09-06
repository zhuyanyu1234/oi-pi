// judge 工具：编译 C++/Python 代码并对若干测试点判题（AC/WA/TLE/RE/CE），支持 Special Judge 与内存限制
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { clip, compileCpp, normalize, run, tail } from "./exec.js";

const MAX_TESTS = 20;
const MAX_TIME_MS = 10_000;
const DEFAULT_TIME_MS = 1_000;
const DEFAULT_MEMORY_MB = 256;
const MAX_REPORT_CHARS = 600;

const Parameters = Type.Object({
  code: Type.String({ description: "完整的源代码（单文件，从标准输入读、向标准输出写）" }),
  language: Type.Optional(
    Type.Union([Type.Literal("cpp"), Type.Literal("python")], { description: "语言，默认 cpp" }),
  ),
  memoryLimitMb: Type.Optional(
    Type.Number({ description: `每个测试点的内存上限 MB，默认 ${DEFAULT_MEMORY_MB}，超出判 RE（需要系统 prlimit）` }),
  ),
  checker_code: Type.Optional(
    Type.String({
      description:
        "Special Judge 的 C++ 源码（可选）。编译后以 ./checker <输入文件> <期望输出文件> <实际输出文件> 运行：" +
        "退出码 0 判 AC，非 0 判 WA，stdout/stderr 会作为提示返回。用于答案不唯一的题（如输出方案、误差允许）",
    }),
  ),
  tests: Type.Array(
    Type.Object({
      name: Type.Optional(Type.String({ description: "测试点名称，如 样例1" })),
      stdin: Type.String({ description: "该测试点的标准输入" }),
      expectedOutput: Type.String({ description: "期望的标准输出（有 checker 时仅作参考传入 checker）" }),
      timeLimitMs: Type.Optional(Type.Number({ description: `时限毫秒数，默认 ${DEFAULT_TIME_MS}，上限 ${MAX_TIME_MS}` })),
    }),
    { description: "测试用例列表", maxItems: MAX_TESTS },
  ),
});

type JudgeParams = Static<typeof Parameters>;

type Verdict = "AC" | "WA" | "TLE" | "RE" | "CE";

interface TestOutcome {
  name: string;
  verdict: Verdict;
  timeMs?: number;
  note?: string;
}

export interface JudgeDetails {
  summary: string;
  passed: number;
  total: number;
  tests: TestOutcome[];
}

/** OJ 常规比较：忽略行尾空白与结尾空行（有 checker 时由 checker 决定） */
function sameOutput(a: string, b: string): boolean {
  return normalize(a) === normalize(b);
}

export const judgeTool: AgentTool<typeof Parameters, JudgeDetails> = {
  name: "judge",
  label: "判题",
  description:
    "编译并判题代码。传入完整源代码与若干测试点（标准输入 + 期望输出），返回每组测试的 AC/WA/TLE/RE 结论、" +
    "用时，以及 WA 时的输出对比。用于写完代码后用题面样例自测。" +
    "支持 C++（默认）与 Python（python3，通常要放宽 timeLimitMs）。" +
    "向 stderr 输出（如 cerr 调试）会被丢弃、不影响判定；判定只看 stdout 与退出码。" +
    "答案不唯一的题可传 checker_code 由 Special Judge 判定。",
  parameters: Parameters,
  executionMode: "sequential",
  async execute(_toolCallId, params: JudgeParams, signal?, onUpdate?: AgentToolUpdateCallback<JudgeDetails>): Promise<AgentToolResult<JudgeDetails>> {
    const tests = params.tests.slice(0, MAX_TESTS);
    if (tests.length === 0) throw new Error("judge 至少需要一组测试点");
    const language = params.language ?? "cpp";
    const memoryMb = Math.min(Math.max(params.memoryLimitMb ?? DEFAULT_MEMORY_MB, 16), 2048);
    const report: string[] = [];
    const finish = (details: JudgeDetails): AgentToolResult<JudgeDetails> => ({
      content: [{ type: "text", text: report.join("\n") }],
      details,
    });

    const dir = await mkdtemp(join(tmpdir(), "oi-pi-judge-"));
    try {
      // 准备提交的代码
      if (language === "python") {
        await writeFile(join(dir, "sol.py"), params.code, "utf8");
      } else {
        const compile = await compileCpp(dir, params.code, { signal });
        if (!compile.ok) {
          report.push(`编译失败：\n${tail(compile.stderr)}`);
          return finish({ summary: "编译失败", passed: 0, total: tests.length, tests: [] });
        }
      }

      // Special Judge（可选）
      const hasChecker = params.checker_code !== undefined && params.checker_code.trim() !== "";
      if (hasChecker) {
        const cc = await compileCpp(dir, params.checker_code!, { sourceName: "checker.cpp", outName: "checker", signal });
        if (!cc.ok) {
          report.push(`Checker 编译失败：\n${tail(cc.stderr)}`);
          return finish({ summary: "Checker 编译失败", passed: 0, total: tests.length, tests: [] });
        }
      }

      const runSol = (input: string, limit: number) =>
        language === "python"
          ? run("python3", { args: [join(dir, "sol.py")], input, timeoutMs: limit, cwd: dir, signal, memoryLimitMb: memoryMb })
          : run(join(dir, "sol"), { input, timeoutMs: limit, cwd: dir, signal, memoryLimitMb: memoryMb });

      // 逐组测试
      const outcomes: TestOutcome[] = [];
      let passed = 0;
      let worstTime = 0;
      for (const [i, test] of tests.entries()) {
        if (signal?.aborted) throw new Error("aborted");
        const name = test.name?.trim() || `测试 ${i + 1}`;
        const limit = Math.min(Math.max(test.timeLimitMs ?? DEFAULT_TIME_MS, 1), MAX_TIME_MS);
        const r = await runSol(test.stdin, limit);
        worstTime = Math.max(worstTime, r.timeMs);
        const timeText = `${Math.round(r.timeMs)}ms`;

        let verdict: Verdict;
        let note: string | undefined;
        if (r.timedOut) {
          verdict = "TLE";
          note = `超过时限 ${limit}ms`;
        } else if (r.outputCapped) {
          verdict = "RE";
          note = "输出超过 1MB 上限被终止";
        } else if (r.code !== 0) {
          verdict = "RE";
          note = r.code === -1
            ? `被信号终止（${memoryMb}MB 内存限制下可能是内存超限，或程序崩溃）${r.stderr.trim() ? `，stderr: ${tail(r.stderr, 200)}` : ""}`
            : `退出码 ${r.code}${r.stderr.trim() ? `，stderr: ${tail(r.stderr, 200)}` : ""}`;
        } else if (hasChecker) {
          await writeFile(join(dir, "input.txt"), test.stdin, "utf8");
          await writeFile(join(dir, "expected.txt"), test.expectedOutput, "utf8");
          await writeFile(join(dir, "actual.txt"), r.stdout, "utf8");
          const ck = await run(join(dir, "checker"), {
            args: ["input.txt", "expected.txt", "actual.txt"],
            timeoutMs: 5_000,
            cwd: dir,
            signal,
          });
          if (ck.code === 0) {
            verdict = "AC";
            passed++;
            if (ck.stdout.trim()) note = `checker: ${clip(ck.stdout.trim(), 200)}`;
          } else {
            verdict = "WA";
            note = ck.timedOut ? "checker 超时" : clip(ck.stdout.trim() || ck.stderr.trim() || `checker 退出码 ${ck.code}`, 300);
          }
        } else if (sameOutput(r.stdout, test.expectedOutput)) {
          verdict = "AC";
          passed++;
        } else {
          verdict = "WA";
          // 普通对比的 WA 把差异写进 note，供 TUI 判题卡片直接展示
          note = `期望 ${clip(JSON.stringify(test.expectedOutput), 60)} · 实际 ${clip(JSON.stringify(r.stdout), 60)}`;
        }
        outcomes.push({ name, verdict, timeMs: Math.round(r.timeMs), note });

        if (verdict === "WA") {
          if (hasChecker && note) {
            report.push(`${name}: WA（${timeText}）— ${clip(note, 300)}`);
          } else {
            report.push(
              `${name}: WA（${timeText}）\n  输入: ${clip(JSON.stringify(test.stdin))}\n` +
              `  期望: ${clip(JSON.stringify(test.expectedOutput))}\n  实际: ${clip(JSON.stringify(r.stdout))}`,
            );
          }
        } else if (verdict !== "AC") {
          report.push(`${name}: ${verdict}（${timeText}）${note ? ` — ${clip(note, 200)}` : ""}`);
        }

        const partial: JudgeDetails = {
          summary: `${passed}/${tests.length} 通过`,
          passed,
          total: tests.length,
          tests: [...outcomes],
        };
        onUpdate?.({ content: [], details: partial });
      }

      const allPassed = passed === tests.length;
      if (allPassed) report.push(`通过 ${passed}/${tests.length}，最长 ${Math.round(worstTime)}ms。`);
      else {
        const verdicts = outcomes.filter((o) => o.verdict !== "AC").map((o) => `${o.name} ${o.verdict}`).join("、");
        report.push(`${passed}/${tests.length} 通过，未通过：${verdicts}。`);
      }
      return finish({
        summary: `${passed}/${tests.length} 通过 · 最长 ${Math.round(worstTime)}ms`,
        passed,
        total: tests.length,
        tests: outcomes,
      });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  },
};
