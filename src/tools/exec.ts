// 工具共用的进程执行与文本辅助：judge / stress / complexity 都靠它跑子进程
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export function normalize(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trimEnd());
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines.join("\n");
}

export function tail(text: string, max = 600): string {
  const t = text.trim();
  return t.length <= max ? t : `…${t.slice(-max)}`;
}

export function clip(text: string, max = 600): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export interface RunOptions {
  args?: string[];
  input?: string;
  timeoutMs: number;
  cwd: string;
  signal?: AbortSignal;
  /** stdout 上限字节；数据生成器应调大（合法数据可达数十 MB） */
  maxOutputBytes?: number;
  /** 虚拟内存上限 MB（prlimit --as），超限被信号杀死（退出码 -1）；缺省不限 */
  memoryLimitMb?: number;
}

export interface RunResult {
  /** 退出码；被信号杀死时为 -1 */
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputCapped: boolean;
  /** 浮点毫秒（hrtime），complexity 需要亚毫秒精度 */
  timeMs: number;
}

const MAX_OUTPUT_BYTES = 1_000_000;
/** 数据生成器的 stdout 上限：合法测试数据可达数十 MB */
export const GEN_OUTPUT_BYTES = 64_000_000;

const PRLIMIT = ["/usr/bin/prlimit", "/bin/prlimit"].find(existsSync) ?? null;

/** 运行一个子进程；stdout 超限时直接杀掉，避免刷爆内存 */
export function run(file: string, options: RunOptions): Promise<RunResult> {
  const maxOutput = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  // prlimit 设 RLIMIT_AS（虚拟内存）；单线程 C++/Python 的 VSZ 接近实际用量，够用
  const useLimit = options.memoryLimitMb !== undefined && PRLIMIT !== null;
  const cmd = useLimit ? PRLIMIT! : file;
  const spawnArgs = useLimit
    ? [`--as=${options.memoryLimitMb! * 1024 * 1024}`, "--", file, ...(options.args ?? [])]
    : (options.args ?? []);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, spawnArgs, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
    const started = process.hrtime.bigint();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let outputCapped = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    const onAbort = () => child.kill("SIGKILL");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > maxOutput) {
        outputCapped = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > MAX_OUTPUT_BYTES) stderr = stderr.slice(0, MAX_OUTPUT_BYTES);
    });
    child.stdin.on("error", () => {}); // 进程提前退出时 write 会 EPIPE，忽略即可
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        reject(err);
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        code: code ?? -1,
        stdout,
        stderr,
        timedOut,
        outputCapped,
        timeMs: Number(process.hrtime.bigint() - started) / 1e6,
      });
    });
  });
}

/** 写入源码并 g++ 编译；失败时 stderr 里带可读原因（含编译超时） */
export async function compileCpp(dir: string, code: string, opts?: {
  sourceName?: string;
  outName?: string;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; stderr: string }> {
  const sourceName = opts?.sourceName ?? "sol.cpp";
  const outName = opts?.outName ?? "sol";
  await writeFile(join(dir, sourceName), code, "utf8");
  const r = await run("g++", {
    args: ["-std=c++20", "-O2", "-pipe", "-fdiagnostics-color=never", "-o", outName, sourceName],
    timeoutMs: 30_000,
    cwd: dir,
    signal: opts?.signal,
  });
  if (r.timedOut) return { ok: false, stderr: "编译超时（30s）" };
  return { ok: r.code === 0, stderr: r.stderr };
}
