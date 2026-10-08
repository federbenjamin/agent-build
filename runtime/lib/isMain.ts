/**
 * Whether the module at `metaUrl` is the script node was started on. Both sides go through
 * realpath: Node resolves symlinks for the main module's `import.meta.url` but leaves
 * `process.argv[1]` as typed, so a script run through a symlinked path (macOS `/tmp` is
 * `/private/tmp`) would otherwise read as imported, run nothing, and exit 0.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isMain(metaUrl: string): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}
