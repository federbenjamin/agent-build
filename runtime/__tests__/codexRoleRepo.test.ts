import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CODEX_PREAMBLE, codexArgs, defaultSandbox, main, roleFromRepo } from "../codexRole.ts";
import { withCapturedConsole } from "./helpers/captureConsole.ts";
import { withTmpDir } from "./helpers/tmpDir.ts";

function writeRepoRole(
  root: string,
  agent: Record<string, unknown>,
  body = "# Role\n\nRead the diff.\n"
): void {
  const agents = join(root, "agents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(root, "agents.json"), JSON.stringify({ agents: [agent] }));
  writeFileSync(join(agents, `${agent.name as string}.md`), `---\nname: ${agent.name as string}\n---\n${body}`);
}

function roleArgs(role: string, tree: string, dispatch: string, out: string): string[] {
  return [role, "--tree", tree, "--dispatch", dispatch, "--out", out];
}

test("a repository role keeps its pins and prompt body without copying frontmatter", () => {
  withTmpDir("codex-role-repo-", (repo) => {
    writeRepoRole(repo, {
      name: "brief-writer",
      codexModel: "gpt-5.6-sol",
      codexReasoningEffort: "xhigh",
      context: { claudeMd: false },
    });
    const role = roleFromRepo("brief-writer", repo);
    assert.deepEqual(role, {
      model: "gpt-5.6-sol",
      effort: "xhigh",
      instructions: `${CODEX_PREAMBLE}\n\n# Role\n\nRead the diff.\n`,
      projectDocs: false,
      sandbox: null,
    });
    writeRepoRole(repo, {
      name: "brief-writer",
      codexModel: "gpt-5.6-sol",
      codexReasoningEffort: "xhigh",
      codexSandboxMode: "workspace-write",
    });
    assert.equal(roleFromRepo("brief-writer", repo)?.sandbox, "workspace-write");
  });
});

test("only claudeMd false suppresses project docs, while absent roles and pins fail explicitly", () => {
  withTmpDir("codex-role-repo-", (repo) => {
    writeRepoRole(repo, {
      name: "reader",
      codexModel: "gpt-5.6-terra",
      codexReasoningEffort: "high",
      context: {},
    });
    assert.equal(roleFromRepo("reader", repo)?.projectDocs, true);
    writeRepoRole(repo, {
      name: "no-project-docs",
      codexModel: "gpt-5.6-terra",
      codexReasoningEffort: "high",
      context: { claudeMd: false },
    });
    assert.equal(roleFromRepo("no-project-docs", repo)?.projectDocs, false);
    assert.equal(roleFromRepo("undeclared", repo), null);

    writeRepoRole(repo, {
      name: "missing-model",
      codexReasoningEffort: "high",
      context: {},
    });
    assert.throws(() => roleFromRepo("missing-model", repo), /codexModel/);

    writeRepoRole(repo, {
      name: "missing-effort",
      codexModel: "gpt-5.6-terra",
      context: {},
    });
    assert.throws(() => roleFromRepo("missing-effort", repo), /codexReasoningEffort/);
  });
});

test("the real repository supplies review and test roles when no generated TOML exists", () => {
  withTmpDir("codex-role-run-", (tree) => {
    const dispatch = join(tree, "dispatch.md");
    const out = join(tree, "out.md");
    writeFileSync(dispatch, "Inspect the implementation.\n");
    const calls: Array<{ role: string; args: string[]; input: string }> = [];
    for (const role of ["review-cursory", "test-author"]) {
      const status = main(roleArgs(role, tree, dispatch, out), {
        readRole: () => null,
        spawn: (_cmd, args, input) => {
          calls.push({ role, args, input });
          return 0;
        },
      });
      assert.equal(status, 0);
    }
    assert.equal(calls.length, 2);
    assert.ok(calls[0]!.input.startsWith(`${CODEX_PREAMBLE}\n\n# review-cursory\n`));
    assert.ok(calls[1]!.input.startsWith(`${CODEX_PREAMBLE}\n\n# test-author\n`));
    assert.deepEqual(
      calls[0]!.args,
      codexArgs({
        tree,
        sandbox: "read-only",
        model: "gpt-5.6-sol",
        effort: "high",
        out,
        projectDocs: true,
      })
    );
    assert.deepEqual(
      calls[1]!.args,
      codexArgs({
        tree,
        sandbox: "workspace-write",
        model: "gpt-5.6-terra",
        effort: "high",
        out,
        projectDocs: false,
      })
    );
  });
});

test("every role the skill runs through <codex_role> gets the sandbox its agents.json row declares", () => {
  const root = join(import.meta.dirname, "..", "..");
  const roles = new Set<string>();
  for (const dir of ["skills/build", "agents"]) {
    for (const file of readdirSync(join(root, dir)).filter((f) => f.endsWith(".md"))) {
      for (const m of readFileSync(join(root, dir, file), "utf8").matchAll(/<codex_role> ([a-z][a-z-]*)/g)) roles.add(m[1]!);
    }
  }
  for (const known of ["review-cursory", "test-author"]) assert.ok(roles.has(known), `the scan finds ${known}`);
  const { agents } = JSON.parse(readFileSync(join(root, "agents.json"), "utf8")) as {
    agents: Array<{ name: string; codexSandboxMode?: string }>;
  };
  for (const role of roles) {
    assert.equal(defaultSandbox(role), agents.find((a) => a.name === role)?.codexSandboxMode, role);
  }
});

test("a dry run reports the repo-derived pins and never spawns Codex", () => {
  withTmpDir("codex-role-dry-run-", (tree) => {
    const dispatch = join(tree, "dispatch.md");
    const out = join(tree, "out.md");
    writeFileSync(dispatch, "Inspect the implementation.\n");
    let spawned = false;
    withCapturedConsole((captured) => {
      const status = main([...roleArgs("review-cursory", tree, dispatch, out), "--dry-run"], {
        readRole: () => null,
        spawn: () => {
          spawned = true;
          return 0;
        },
      });
      assert.equal(status, 0);
      assert.equal(spawned, false);
      assert.deepEqual(captured.errors, []);
      assert.deepEqual(captured.logs.slice(0, 5), [
        "role: agents.json + agents/review-cursory.md",
        "model: gpt-5.6-sol",
        "effort: high",
        "sandbox: read-only",
        "project docs: yes",
      ]);
      assert.equal(
        captured.logs[5],
        `codex: ${codexArgs({
          tree,
          sandbox: "read-only",
          model: "gpt-5.6-sol",
          effort: "high",
          out,
          projectDocs: true,
        }).join(" ")}`
      );
      assert.equal(captured.logs.length, 6);
    });
  });
});
