/**
 * buildEvent — the one emitter of the build's lifecycle events (README §Build events). It validates
 * the event first, so a malformed emit line in a stop file fails every run, listener or not; then,
 * when the launcher set `BUILD_EVENT_CMD`, it runs that command (split on whitespace, never a shell)
 * with the event's JSON on stdin and drops its stdout. A consumer never fails a build: its failure
 * or timeout is one warning and exit 0.
 *
 *   node ~/.agent-build/runtime/buildEvent.ts <event> --runid <id> [flags]
 * Exit 0: sent, nobody listening, or the consumer failed (warned). Exit 2: a usage or validation error.
 */

import {
  BUILD_EVENT_FIELDS,
  BUILD_EVENT_NAMES,
  BUILD_EVENT_SCHEMA,
  BuildEventError,
  formatBuildEvent,
  isBuildEventName,
  parseBuildEvent,
} from "./lib/buildEvents.ts";
import { assertKnownFlags, takeValue, takeValues } from "./lib/cliArgs.ts";
import { exitWhenFlushed } from "./lib/exitWhenFlushed.ts";
import { type ExecFn, runOut } from "./lib/gitOps.ts";
import { isMain } from "./lib/isMain.ts";
import { loadThresholds } from "./thresholds.ts";

/** The environment variable a launcher sets: the consumer command line. */
export const BUILD_EVENT_CMD = "BUILD_EVENT_CMD";

/** Usage: `buildEvent.ts <event> --runid <id> [--unit <id>=<title>]… [--id <id>] [--pr <n>] [--needs <text>] [--outcome merged|unmerged]`. */
export const USAGE =
  "usage: buildEvent.ts <event> --runid <id> [--unit <id>=<title>]… [--id <id>] [--pr <n>] [--needs <text>] [--outcome merged|unmerged]";

const flagOf = (field: string): string => (field === "units" ? "--unit" : `--${field}`);

/** The consumer command line, trimmed; `""` when nobody is listening. */
function consumerLine(env: Record<string, string | undefined>): string {
  return (env[BUILD_EVENT_CMD] ?? "").trim();
}

/** The raw event object from argv, `at` from `now`; throws `Error` on a usage error (unknown event, unknown flag,
 *  a flag without a value, a `--unit` without `=`, a `--pr` that is not all digits). The result is not yet validated. */
export function eventFromArgv(argv: string[], now: Date): unknown {
  const [event, ...flags] = argv;
  if (!isBuildEventName(event)) {
    throw new Error(`unknown event ${JSON.stringify(event ?? "")}, expected one of: ${BUILD_EVENT_NAMES.join(", ")}`);
  }
  const fields: readonly string[] = BUILD_EVENT_FIELDS[event];
  assertKnownFlags(flags, ["--runid", ...fields.map(flagOf)]);
  const raw: Record<string, unknown> = { schema: BUILD_EVENT_SCHEMA };
  let rest = flags;
  const single = (flag: string): string | undefined => {
    const r = takeValue(rest, flag);
    rest = r.rest;
    return r.value;
  };
  const runid = single("--runid");
  if (runid !== undefined) raw.runid = runid;
  raw.at = now.toISOString();
  raw.event = event;
  for (const field of fields) {
    if (field === "units") {
      const r = takeValues(rest, "--unit");
      rest = r.rest;
      raw.units = r.values.map((u) => {
        const eq = u.indexOf("=");
        if (eq < 0) throw new Error(`--unit takes <id>=<title>, got ${JSON.stringify(u)}`);
        return { id: u.slice(0, eq), title: u.slice(eq + 1) };
      });
      continue;
    }
    const value = single(flagOf(field));
    if (value === undefined) continue;
    if (field === "pr") {
      if (!/^\d+$/.test(value)) throw new Error(`--pr takes a PR number, got ${JSON.stringify(value)}`);
      raw.pr = Number(value);
    } else {
      raw[field] = value;
    }
  }
  if (rest.length > 0) throw new Error(`unexpected argument(s): ${rest.join(" ")}`);
  return raw;
}

export interface BuildEventDeps {
  env: Record<string, string | undefined>;
  now: () => Date;
  timeoutMs: number;
  exec?: ExecFn;
}

function childStderr(e: unknown): string {
  const raw = (e as { stderr?: unknown }).stderr;
  if (typeof raw === "string") return raw.trim();
  if (Buffer.isBuffer(raw)) return raw.toString("utf8").trim();
  return "";
}

/** The whole run but the process: exit 2 with the usage or validation errors on `stderr`; exit 0 and empty `stderr`
 *  when the env is unset or the consumer succeeded; exit 0 and one warning when it failed or timed out. */
export function runBuildEvent(argv: string[], deps: BuildEventDeps): { exit: 0 | 2; stderr: string[] } {
  let input: string;
  try {
    input = formatBuildEvent(parseBuildEvent(eventFromArgv(argv, deps.now())));
  } catch (e) {
    if (e instanceof BuildEventError) return { exit: 2, stderr: e.issues.map((i) => `buildEvent: ${i.message}`) };
    return { exit: 2, stderr: [`buildEvent: ${(e as Error).message}`, USAGE] };
  }
  const cmdLine = consumerLine(deps.env);
  if (cmdLine === "") return { exit: 0, stderr: [] };
  const [cmd, ...args] = cmdLine.split(/\s+/) as [string, ...string[]];
  try {
    runOut(cmd, args, { input, timeout: deps.timeoutMs, ...(deps.exec === undefined ? {} : { exec: deps.exec }) });
    return { exit: 0, stderr: [] };
  } catch (e) {
    const message = (e instanceof Error ? e.message : String(e)).trim();
    const stderr = childStderr(e);
    const tail = stderr !== "" && !message.includes(stderr) ? `\n${stderr}` : "";
    const reason = args.length === 0 ? message : message.replace([cmd, ...args].join(" "), () => cmd);
    return { exit: 0, stderr: [`buildEvent: ${BUILD_EVENT_CMD} failed (${cmd}): ${reason}${tail}`] };
  }
}

async function main(): Promise<void> {
  let timeoutMs = 0;
  if (consumerLine(process.env) !== "") {
    try {
      timeoutMs = (await loadThresholds(process.cwd())).values.BUILD_EVENT_TIMEOUT_MS;
    } catch (e) {
      console.error(`buildEvent: ${(e as Error).message}`);
      exitWhenFlushed(2);
      return;
    }
  }
  const { exit, stderr } = runBuildEvent(process.argv.slice(2), { env: process.env, now: () => new Date(), timeoutMs });
  for (const line of stderr) console.error(line);
  exitWhenFlushed(exit);
}

if (isMain(import.meta.url)) {
  await main();
}
