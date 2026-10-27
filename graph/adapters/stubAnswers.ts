/** The stub classifier and the stub check: both answer from the binding's fixture map by role. */

import type { StubCheckBinding, StubClassifierBinding, StubAnswers } from "../contracts.ts";
import type { CheckRunner, Classifier } from "./types.ts";

/** The role's answer: its fixed answer, or its list read by iteration (1-based, iteration 0 reads
 *  the first, the last repeating); the default for a role the map does not name. */
export function stubAnswer<A>(binding: StubAnswers<A>, role: string, iteration: number): A {
  if (!Object.hasOwn(binding.answers, role)) return binding.default;
  const a = binding.answers[role] as A | A[];
  if (!Array.isArray(a)) return a;
  return a[Math.min(Math.max(iteration, 1), a.length) - 1] ?? binding.default;
}

export function stubClassifier(binding: StubClassifierBinding): Classifier {
  return {
    async classify(req) {
      return { ...stubAnswer(binding, req.question, req.iteration) };
    },
  };
}

export function stubCheck(binding: StubCheckBinding): CheckRunner {
  return {
    async run(req) {
      const answer = stubAnswer(binding, req.role, req.iteration);
      return { answer, detail: `stub check ${req.role}: ${answer} on iteration ${req.iteration}` };
    },
  };
}
