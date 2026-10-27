/**
 * The engine pieces G3 added, one test each: gates on data (`anyOf`, `allOf`), fan-outs, question
 * routing, per-reader carried reads, and the question and answer files. Merge-back has its own file.
 */

import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { test } from "node:test";

import { CROSSTALK_FILE, OUTPUT_SIDE_FILES, QUESTIONS_FILE, STRUGGLES_FILE } from "../constants.ts";
import { type Answer, type NodeDef, parseAnswerFile, parseQuestions, type DataValues, type Question } from "../contracts.ts";
import { carriedReads, gateFails } from "../define.ts";
import { graph } from "../pipelines/build.ts";
import { answerText, blockedText, fanOutExports, fanOutProblems, operatorAsk, questionsOnly, readyItems, replyAnswer, routeQuestion } from "../schedule.ts";

const check = (answer: "pass" | "fail") => ({ schema: "check" as const, answer, detail: "" });

test("a gate on data: one leaf, any of, all of, and a leaf that did not answer", () => {
  const gate = graph.nodes.find((n) => n.id === "K-pre-push")!.gate!;
  const at = (d: DataValues) => gateFails(graph, gate, d);
  assert.equal(at({ "fix-owed": check("fail"), "main-moved": check("pass"), "nothing-open": check("pass") }), null);
  assert.equal(at({ "fix-owed": check("fail"), "nothing-open": check("fail") }), null, "any of: the banked path opens it without drift");
  assert.match(at({ "fix-owed": check("pass"), "main-moved": check("pass") })!, /fix-owed answered pass, not fail/);
  assert.match(at({ "fix-owed": check("fail"), "main-moved": check("fail"), "nothing-open": check("pass") })!, /none of/);
  assert.match(at({})!, /fix-owed did not answer/);
});

test("a fan-out: items start when the items they come after finished, problems are named, exports join", () => {
  const items = [
    { id: "P1", after: [] },
    { id: "P2", after: ["P1"] },
    { id: "P3", after: [] },
  ];
  assert.deepEqual(fanOutProblems(items), []);
  assert.deepEqual(fanOutProblems([{ id: "P1", after: ["P9"] }]).length, 1);
  assert.deepEqual(readyItems(items, new Set(), new Set()), ["P1", "P3"]);
  assert.deepEqual(readyItems(items, new Set(["P1", "P3"]), new Set(["P1"])), ["P2"]);
  const out = fanOutExports(
    ["P1", "P2"],
    new Map<string, DataValues>([
      ["P1", { report: { schema: "files", files: ["/a"] }, head: { schema: "ref", kind: "commit", id: "1" }, ok: check("pass") }],
      ["P2", { report: { schema: "files", files: ["/b"] }, head: { schema: "ref", kind: "commit", id: "2" }, ok: check("fail") }],
    ])
  );
  assert.deepEqual(out.report, { schema: "files", files: ["/a", "/b"] });
  assert.equal(out.head?.schema === "ref" && out.head.id, "2");
  assert.equal(out.ok?.schema === "check" && out.ok.answer, "fail");
});

test("question routing: blocked retries once then asks the operator; a product question, searched or not, never reaches the resolver", () => {
  const q = (type: Question["type"], searched: Question["searched"] = []): Question => ({ id: "Q.1", type, text: "?", searched });
  assert.equal(routeQuestion(q("blocked"), { hasResolver: true, retried: false }), "retry");
  assert.equal(routeQuestion(q("blocked"), { hasResolver: true, retried: true }), "operator");
  assert.equal(routeQuestion(q("product", [{ source: "plan", said: "nothing" }]), { hasResolver: true, retried: false }), "operator");
  assert.equal(routeQuestion(q("product"), { hasResolver: true, retried: false }), "operator");
  assert.equal(routeQuestion(q("public-surface"), { hasResolver: true, retried: false }), "resolver");
  assert.equal(routeQuestion(q("public-surface"), { hasResolver: false, retried: false }), "operator");
});

test("after the resolver: its answer stands unless it changes a brief the graph will amend, which the operator approves or answers instead", () => {
  const q: Question = { id: "Q.1", type: "brief", text: "?", searched: [] };
  const searched = [{ source: "brief", said: "names v1" }];
  const plain: Answer = { question_id: "Q.1", answer: "v2", source: "brief", by: "resolver", searched };
  const change: Answer = { ...plain, brief_change: "say v2" };
  assert.deepEqual(operatorAsk(plain, true), { answer: plain });
  assert.deepEqual(operatorAsk(change, false), { answer: change }, "nothing will apply the change: it stands, for the asker to read");
  const ask = operatorAsk(change, true);
  assert.ok("ask" in ask && /This changes the brief: say v2 Reply approve to apply it, or write the answer instead\./.test(ask.ask));
  assert.deepEqual(operatorAsk({ needsOperator: true, searched }, true), { ask: "The resolver found no answer in: brief: names v1." });
  assert.deepEqual(operatorAsk(undefined, true), { ask: "" });
  assert.equal(replyAnswer(q, change, "  APPROVE "), change);
  const own = { question_id: "Q.1", answer: "keep v1", source: "operator", by: "operator" };
  assert.deepEqual(replyAnswer(q, change, "keep v1"), own);
  assert.deepEqual(replyAnswer(q, plain, "approve"), { ...own, answer: "approve" }, "approve applies only a proposed change");
  assert.deepEqual(replyAnswer(q, { needsOperator: true, searched }, "keep v1"), own);
  assert.equal(answerText(q, change), "Q.1: v2 Brief change: say v2 (source: brief)");
  assert.equal(answerText(q, plain), "Q.1: v2 (source: brief)");
});

test("questions only: an agent output holding nothing but its questions file, never the engine's answers output", () => {
  const node = { id: "A-x", kind: "agent", role: "x", inputs: [], outputs: ["fix-file", "fix-answers", "commit"], answers: "fix-answers", timeCapMs: 1 } as NodeDef;
  const files = (...f: string[]) => ({ schema: "files" as const, files: f });
  const commit = { schema: "ref" as const, kind: "commit" as const, id: "1" };
  assert.deepEqual(questionsOnly(node, { "fix-file": files("/o/fix-file/questions.json"), "fix-answers": files("/o/fix-answers/answers.json"), commit }), ["fix-file"]);
  assert.deepEqual(questionsOnly(node, { "fix-file": files("/o/fix-file/questions.json", "/o/fix-file/fix-1.txt"), commit }), []);
  assert.deepEqual(questionsOnly(node, { "fix-file": files(), "fix-answers": files("/o/questions.json") }), [], "an empty output is the schema check's, and the answers output is the engine's");
});

test("the side files: questions, struggles and crosstalk beside a stopped output still read as stopped on its questions, the list K-output-format leaves unchecked", () => {
  assert.deepEqual(OUTPUT_SIDE_FILES, [QUESTIONS_FILE, STRUGGLES_FILE, CROSSTALK_FILE]);
  const node = { id: "A-x", kind: "agent", role: "x", inputs: [], outputs: ["fix-file"], timeCapMs: 1 } as NodeDef;
  const files = (...f: string[]) => ({ "fix-file": { schema: "files" as const, files: f.map((n) => `/o/fix-file/${n}`) } });
  assert.deepEqual(questionsOnly(node, files(QUESTIONS_FILE, STRUGGLES_FILE)), ["fix-file"], "a struggles file does not make the questions an output");
  assert.deepEqual(questionsOnly(node, files(QUESTIONS_FILE, STRUGGLES_FILE, CROSSTALK_FILE)), ["fix-file"]);
  assert.deepEqual(questionsOnly(node, files(STRUGGLES_FILE, CROSSTALK_FILE)), [], "side files with no questions stopped on nothing");
  assert.deepEqual(questionsOnly(node, files(QUESTIONS_FILE, CROSSTALK_FILE, "fix-1.txt")), []);
});

test("carried reads: only a back edge reads last iteration's value; a forward reader in the loop reads this one", () => {
  const close = graph.loops.find((l) => l.id === "close")!;
  const reads = carriedReads(graph, close);
  assert.ok(reads.get("D-build-fix-table")?.has("table"), "the table reads its own last table");
  assert.ok(reads.get("D-build-fix-table")?.has("fix-file"), "and the last fix file");
  assert.ok(!reads.get("A-fixer")?.has("table"), "the fixer reads this iteration's table");
  assert.ok(!reads.get("K-loop-done")?.has("table"));
});

test("a blocked asker's fresh rerun is handed its own question and what it searched, from its last run, not as an answer", () => {
  const q: Question = { id: "F.1", type: "blocked", text: "the table names a file the diff deleted.", searched: [{ source: "code", said: "src/a.ts is gone" }, { source: "brief", said: "lists src/a.ts" }] };
  assert.equal(blockedText(q), "F.1: blocked on the last run: the table names a file the diff deleted. Searched: code: src/a.ts is gone; brief: lists src/a.ts. (source: your last run)");
  assert.equal(blockedText({ ...q, searched: [] }), "F.1: blocked on the last run: the table names a file the diff deleted. (source: your last run)");
});

test("question and answer files: an answer and a refusal both say what was searched, and the resolver never answers as the operator", () => {
  const [q] = parseQuestions([{ id: "P1-Q.1", type: "brief", text: "amend?", searched: [{ source: "brief", said: "x" }] }]);
  assert.equal(q!.id, "P1-Q.1");
  assert.throws(() => parseQuestions([{ id: "Q", type: "nope", text: "?", searched: [] }]));
  const searched = [{ source: "code", said: "src/a.ts:3 already returns early" }];
  assert.deepEqual(parseAnswerFile({ needs_operator: true, searched }, q!), { needsOperator: true, searched });
  const a = parseAnswerFile({ answer: "yes", source: "code", searched, brief_change: "H1" }, q!);
  assert.ok(!("needsOperator" in a) && a.question_id === "P1-Q.1" && a.brief_change === "H1" && a.by === "resolver");
  assert.deepEqual(a.searched, searched);
  assert.throws(() => parseAnswerFile({ answer: "yes", source: "operator", searched }, q!), /source/);
  for (const raw of [{ answer: "yes", source: "code", searched: [] }, { answer: "yes", source: "code" }, { needs_operator: true, searched: [] }]) {
    assert.throws(() => parseAnswerFile(raw, q!), /searched/, JSON.stringify(raw));
  }
});
