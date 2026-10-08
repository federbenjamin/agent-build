/**
 * The bounded real-process spawn for a build-runtime self-test. A KILLED child does not look killed
 * at an exit-code assertion (`spawnSync` reports its own timeout as `status: null`), so this throws
 * first and names the budget instead of handing an assertion a value it will misread.
 */
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";

const SPAWN_TIMEOUT_MS = 60_000;
const STDERR_TAIL_CHARS = 2_000;

export interface SmokeRun {
  status: number;
  stdout: string;
  stderr: string;
}

type SmokeOptions = Omit<Partial<SpawnSyncOptionsWithStringEncoding>, "encoding">;

export function spawnSmoke(
  command: string,
  args: readonly string[],
  options: SmokeOptions = {}
): SmokeRun {
  const timeout = options.timeout ?? SPAWN_TIMEOUT_MS;
  // Node's type-stripping warning would otherwise land in every child's stderr.
  const env = { ...(options.env ?? process.env), NODE_NO_WARNINGS: "1" };
  const r = spawnSync(command, [...args], { ...options, env, encoding: "utf8", timeout });
  if (
    (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ||
    r.signal !== null ||
    r.status === null
  ) {
    throw new Error(
      `TIMEOUT or kill after the ${Math.round(timeout / 1000)}s budget: ${command} ${args.join(" ")}\n` +
        (r.stderr ?? "").slice(-STDERR_TAIL_CHARS)
    );
  }
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
