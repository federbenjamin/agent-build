/** The run store as files: `<dir>/<key>.json` per record, `<dir>/<key>/` for a folder a node writes. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { RunStore } from "./types.ts";

const KEY = /^[\w.-]+(?:\/[\w.-]+)*$/;

function checkKey(key: string): string {
  if (!KEY.test(key) || key.split("/").some((part) => part === "." || part === "..")) {
    throw new Error(`run store key ${JSON.stringify(key)} must be a relative path of plain names`);
  }
  return key;
}

export function fileRunStore(dir: string): RunStore {
  return {
    dir,
    path: (key) => join(dir, checkKey(key)),
    write(key, value) {
      const file = join(dir, `${checkKey(key)}.json`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
    },
    read(key) {
      const file = join(dir, `${checkKey(key)}.json`);
      return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as unknown) : undefined;
    },
  };
}
