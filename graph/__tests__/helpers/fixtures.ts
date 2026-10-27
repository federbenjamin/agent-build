/** Where the recorded mock fixtures are, and the skip reason for a checkout without them: the
 *  fixtures stay in the private repo, so a test that replays one skips there instead of failing. */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");

/** False when `graph/fixtures/` is here; else why a fixture test skips. */
export const NO_FIXTURES: string | false = existsSync(FIXTURES) ? false : "graph/fixtures/ is not in this checkout: the recorded runs stay in the private repo";
