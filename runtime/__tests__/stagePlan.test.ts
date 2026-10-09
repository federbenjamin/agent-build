/** stagePlan: the printed plan for one read after a fix — range, readers, hand-test claims and their
 *  needs — and its exit codes, over throwaway repos with a fake signals arm. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { formatHandTest, main } from "../stagePlan.ts";
import { withCapturedConsole } from "./helpers/captureConsole.ts";
import { BRIEF_PATH, briefedHead, briefText, EXIT_CHECKS, type Run, TWO_CLAIMS, withRun } from "./helpers/owedRun.ts";

const R2_BRIEF = { brief: briefText({ cls: "R2" }) };

async function plan(run: Run, args: string[]): Promise<{ code: number | undefined; out: string[]; err: string[] }> {
  let code: number | undefined;
  const captured = await withCapturedConsole(async (c) => {
    await main(["--run-dir", run.runDir, ...args], (n) => (code ??= n), { cwd: run.repo, deps: { hunterMinLines: 20 } });
    return c;
  });
  return { code, out: captured.logs.join("\n").split("\n"), err: captured.errors };
}

test("confirm-1 at R2 prints the range, both signals with their source, each reader, and the claims to run", async () => {
  await withRun(async (run) => {
    const s1 = run.commit({ "src/auth.ts": "export const token = 2;\n" }, "fix(close): round 1 — 1 rows");
    run.ledger([...briefedHead("R2", run.wave), `fix-1: 1/1 | model=sonnet | agent=f1 | from=${run.wave} | sha=${s1}`]);
    const r = await plan(run, ["--stage", "confirm-1"]);
    assert.equal(r.code, 0, r.err.join("\n"));
    assert.deepEqual(r.out, [
      `stage confirm-1 · range ${run.wave.slice(0, 9)}..${s1.slice(0, 9)} · pr-code: changed (1 path) (source repo) · fix-security: fires (path src/auth.ts) (source repo)`,
      "reader: review-cursory-codex — owed (every read after a fix)",
      "reader: gate-silent-failure-hunter — sits out (6 counted lines < 20, no catch/await/Promise)",
      "reader: security-review — owed (R2; fix-security fires)",
      "reader: build-verifier — not owed (no amend brief:, no rename); run <manifest> --brief-file <brief> --no-exercise yourself",
      "hand-test: all claims (H1) · needs: stack",
    ]);
  }, R2_BRIEF);
});

test("an `amend brief:` that changes only hand-test text owes no verifier, and prints the manifest note", async () => {
  await withRun(async (run) => {
    const amend = run.commit({ [BRIEF_PATH]: briefText().replace("pass: exit 0", "pass: exit 0 and prints ok") }, "amend brief: H1 says what it prints");
    run.ledger([...briefedHead("R1", run.wave), `fix-1: 1/1 | model=sonnet | agent=f1 | from=${run.wave} | sha=${amend}`]);
    const r = await plan(run, ["--stage", "confirm-1"]);
    assert.equal(r.code, 0, r.err.join("\n"));
    assert.ok(
      r.out.includes(
        "reader: build-verifier — not owed (the `amend brief:` commit changes no deliverable or assertion, no rename); run <manifest> --brief-file <brief> --no-exercise yourself"
      ),
      r.out.join("\n")
    );
  });
});

test("a brief committed after the code: the plan refuses with the order failure, exit 2", async () => {
  await withRun(
    async (run) => {
      const late = run.commit({ [BRIEF_PATH]: briefText() }, "brief: quick-x, after the code");
      run.ledger([...briefedHead("R1", run.wave), `fix-1: 1/1 | model=sonnet | agent=f1 | from=${run.wave} | sha=${late}`]);
      const r = await plan(run, ["--stage", "confirm-1"]);
      assert.equal(r.code, 2);
      assert.deepEqual(r.err, [
        `stagePlan: brief: ${BRIEF_PATH} was first committed at ${late}, not as the branch's first commit ${run.wave}, so it post-dates the work it grades`,
      ]);
    },
    { brief: null }
  );
});

test("at R1 the security read is not asked (the R2-only rule)", async () => {
  await withRun(async (run) => {
    const s1 = run.commit({ "src/auth.ts": "export const token = 2;\n" }, "fix 1");
    run.ledger([...briefedHead("R1", run.wave), `fix-1: 1/1 | model=sonnet | agent=f1 | from=${run.wave} | sha=${s1}`]);
    const r = await plan(run, ["--stage", "confirm-1"]);
    assert.equal(r.code, 0, r.err.join("\n"));
    assert.match(r.out[0]!, / · fix-security: not asked \(R1\)$/);
    assert.ok(r.out.includes("reader: security-review — not owed (R1; the security read of a fix is R2 only)"), r.out.join("\n"));
  });
});

test("a read that is not owed prints one line, then only the failed claims", async () => {
  await withRun(
    async (run) => {
      run.write("fix-2.txt", `CURSORY.2 · fixed · ${run.wave} — already so\n${EXIT_CHECKS}\n`);
      run.write("hand-test-1.txt", `H1 · pass · ${run.wave} — hand-test-1/H1.out\nH2 · fail (code) · ${run.wave} — hand-test-1/H2.out — no second answer\n`);
      run.ledger([...briefedHead("R1", run.wave), `fix-2: 1/1 | model=sonnet | agent=f2 | from=${run.wave} | sha=${run.wave}`]);
      const r = await plan(run, ["--stage", "confirm-2"]);
      assert.equal(r.code, 0, r.err.join("\n"));
      assert.deepEqual(r.out, [
        "stage confirm-2: not owed — fix-2 changed no file and dropped no row",
        "hand-test: claims H2 · needs: sim",
      ]);
    },
    { brief: briefText({ claims: TWO_CLAIMS }) }
  );
});

test("branch=: a tree on another branch than the ledger's is exit 2 with the message; its own branch plans", async () => {
  await withRun(async (run) => {
    const s1 = run.commit({ "src/auth.ts": "export const token = 2;\n" }, "fix 1");
    const lines = (b: string) => [
      ...briefedHead("R1", run.wave).map((l) => (l.startsWith("freshen:") ? `freshen: merged | base=main | branch=${b} | sha=${run.wave}` : l)),
      `fix-1: 1/1 | model=sonnet | agent=f1 | from=${run.wave} | sha=${s1}`,
    ];
    run.ledger(lines("quick/other"));
    const other = await plan(run, ["--stage", "confirm-1"]);
    assert.deepEqual([other.code, other.err], [2, ["stagePlan: run run is on quick/other; this tree is on quick/x — enter the run's tree first"]]);
    run.ledger(lines("quick/x"));
    const own = await plan(run, ["--stage", "confirm-1"]);
    assert.equal(own.code, 0, own.err.join("\n"));
  });
});

test("one drift group per build: `--stage drift` from another head than the recorded group's start is exit 2", async () => {
  await withRun(async (run) => {
    const later = run.commit({ "src/app.ts": "export const a = 7;\n" }, "later");
    run.ledger([...briefedHead("R1", run.wave), `drift-read: review-cursory | from=${run.wave} | files=1 | sha=${run.wave}`]);
    const r = await plan(run, ["--stage", "drift", "--from", later]);
    assert.deepEqual([r.code, r.err], [2, ["stagePlan: one drift group per build — merge main, write `drift-merge:`; SHIP's pre-push checks cover it"]]);
  });
});

test("hand-test lines: none, all, a subset, and the needs of only the claims listed", () => {
  const s = (id: string, passed: boolean, needs: ("stack" | "sim")[] = []) => ({ id, passed, needs, why: "" });
  assert.equal(formatHandTest([]), "hand-test: none (no claims)");
  assert.equal(formatHandTest([s("H1", true, ["stack"])]), "hand-test: none");
  assert.equal(formatHandTest([s("H1", false), s("H2", false)]), "hand-test: all claims (H1 H2)");
  assert.equal(
    formatHandTest([s("H1", true, ["stack"]), s("H2", false, ["sim"]), s("H4", false, ["stack", "sim"])]),
    "hand-test: claims H2 H4 · needs: stack, sim"
  );
});

test("a signals arm that could not run here exits 1 with one line; bad input exits 2", async () => {
  const eperm = `console.error("Error: listen EPERM: operation not permitted /tmp/tsx-501/1.pipe"); process.exit(1);`;
  await withRun(
    async (run) => {
      const s1 = run.commit({ "src/app.ts": "export const a = 3;\n" }, "fix 1");
      run.ledger([...briefedHead("R2", run.wave), `fix-1: 1/1 | model=sonnet | agent=f1 | from=${run.wave} | sha=${s1}`]);
      const r = await plan(run, ["--stage", "confirm-1"]);
      assert.equal(r.code, 1);
      assert.equal(r.err.length, 1);
      assert.match(r.err[0]!, /^stagePlan: the signals arm could not run here \(.*listen EPERM.*\) — re-run outside the sandbox$/);
      assert.deepEqual(r.out, [""], "nothing printed to stdout");

      const drift = await plan(run, ["--stage", "drift"]);
      assert.equal(drift.code, 2);
      assert.match(drift.err[0]!, /--stage drift needs --from/);
      const bad = await plan(run, ["--stage", "confirm-9"]);
      assert.equal(bad.code, 2);
      const unknown = await plan(run, ["--stage", "confirm-1", "--round", "1"]);
      assert.equal(unknown.code, 2);
      assert.match(unknown.err[0]!, /unknown flag\(s\): --round/);
    },
    { arm: eperm, ...R2_BRIEF }
  );
});

test("a repo with no signals step plans on the fallback and prints its note", async () => {
  await withRun(
    async (run) => {
      const s1 = run.commit({ "src/app.ts": "export const a = 3;\n" }, "fix 1");
      run.ledger([...briefedHead("R2", run.wave), `fix-1: 1/1 | model=sonnet | agent=f1 | from=${run.wave} | sha=${s1}`]);
      const r = await plan(run, ["--stage", "confirm-1"]);
      assert.equal(r.code, 0, r.err.join("\n"));
      assert.match(r.out[0]!, /pr-code: changed \(1 path\) \(source fallback\) · fix-security: fires \(fallback — no fix-security arm\) \(source fallback\)$/);
      assert.ok(r.out.some((l) => l.startsWith("signals: fallback — the repo maps no signals step")), r.out.join("\n"));
    },
    { arm: null, ...R2_BRIEF }
  );
});
