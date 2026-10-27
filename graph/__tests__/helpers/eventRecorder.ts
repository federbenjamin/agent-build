/**
 * A build-event consumer for tests: a run whose `events` is `recorderCmd` hands each event to a
 * script that appends it to this process's own events file, read back with `recordedEvents`.
 */

import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "graph-event-recorder-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const eventsFile = join(dir, "events.jsonl");
const recorder = join(dir, "recorder.mjs");
writeFileSync(recorder, 'import { appendFileSync } from "node:fs";\nlet s = "";\nprocess.stdin.on("data", (d) => (s += d)).on("end", () => appendFileSync(process.argv[2], s));\n');
appendFileSync(eventsFile, "");

/** The consumer command line of this process's recorder: `<node> <recorder.mjs> <events file>`. */
export const recorderCmd = `${process.execPath} ${recorder} ${eventsFile}`;

/** Every build event the recorder received so far, oldest first. */
export function recordedEvents(): Record<string, unknown>[] {
  return readFileSync(eventsFile, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
}
