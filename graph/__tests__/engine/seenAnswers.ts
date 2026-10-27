/**
 * A stub agent for the blocked-question tests (a binding's `replay` module): it runs the plain stub
 * and appends the answers each run was handed to `<fixtureDir>/seen-<role>.jsonl`, one line per run.
 * A run handed answers copies from `<role>-answered/` when the fixtures hold one.
 */

import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { stubAgent } from "../../adapters/stubAgent.ts";
import type { AgentRequest, AgentResult, AgentRunner } from "../../adapters/types.ts";
import type { StubAgentBinding } from "../../contracts.ts";

export function replayAgent(binding: StubAgentBinding): AgentRunner {
  const { replay: _, ...plain } = binding;
  const stub = stubAgent(plain);
  return {
    async run(req: AgentRequest): Promise<AgentResult> {
      appendFileSync(join(binding.fixtureDir, `seen-${req.role}.jsonl`), `${JSON.stringify(req.answers)}\n`);
      const answered = `${req.role}-answered`;
      return stub.run(req.answers.length > 0 && existsSync(join(binding.fixtureDir, answered)) ? { ...req, role: answered } : req);
    },
  };
}
