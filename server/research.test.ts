// 가상 응답으로 판본·인용·예산·캐시 경계를 검증한다.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { fixtureClient, recording } from "../fixtures/research/recording.ts";
import { startServer } from "./http.ts";
import { openLibrary } from "./library.ts";
import { openResearch, type ResearchStatus } from "./research.ts";

const root = resolve();
const work = resolve("work");

async function dataDir(t: TestContext) {
  await mkdir(work, { recursive: true });
  const dir = await mkdtemp(join(work, "research-test-"));
  t.after(async () => {
    assert.equal(dirname(dir), work);
    assert(basename(dir).startsWith("research-test-"));
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

const input = { action: "start", query: "Morrow Finch" };
const choose = (result: ResearchStatus, index = 0) => ({ action: "select", id: result.id, retrievedAt: result.retrievedAt, index });
const pending = (value: ResearchStatus) => ["identifying", "researching", "normalizing"].includes(value.phase);

async function settled(research: ReturnType<typeof openResearch>, result: ResearchStatus) {
  for (let step = 0; step < 20 && pending(result); step++) {
    await settle();
    result = research.status(result.id);
  }
  assert(!pending(result));
  return result;
}

function oneCandidate(): Anthropic.Message {
  const message = structuredClone(recording.identify);
  const first = message.content.find(block => block.type === "text")!;
  first.text = JSON.stringify(JSON.parse(first.text).slice(0, 1));
  return message;
}

test("판본 선택 전에는 상세 조사하지 않고 무료 재열기에서 원문과 비용 기록을 이어 쓴다", async t => {
  const dir = await dataDir(t);
  const connectors = openLibrary(root, dir).describe().connectors;
  const { calls, client } = fixtureClient([recording.identify, recording.investigate, recording.normalized]);
  const research = openResearch(dir, connectors, client);
  const start = research.submit(input);
  assert.equal(research.submit(input).id, start.id);
  const result = await settled(research, start);
  assert.equal(result.phase, "choosing");
  assert.deepEqual(result.candidates.map(candidate => candidate.revision), ["FA-24", "FA-25"]);
  assert.equal(calls.length, 1);
  assert.throws(() => research.submit(choose(result, 5)), /선택할 수 있는 판본/);
  const reopened = openResearch(dir, connectors, client);
  assert.deepEqual(reopened.submit(input), result);

  const approved = reopened.submit(choose(result));
  assert.throws(() => reopened.submit(choose(result)), /선택할 수 있는 판본/);
  const completed = await settled(reopened, approved);
  assert.equal(completed.phase, "complete");
  assert.equal(calls.length, 3);
  assert.equal(completed.searches, 3);
  assert.equal(completed.spentUsd.toFixed(6), "0.082068");
  assert.deepEqual(calls[0]!.tools?.map(tool => "name" in tool ? tool.name : undefined), ["web_search", "web_fetch"]);
  assert.equal(calls[2]!.tools, undefined);
  assert.equal(calls[2]!.output_config?.format?.type, "json_schema");
  assert.equal(Object.hasOwn(completed, "raw"), false);

  const saved = JSON.parse(await readFile(join(dir, "research", completed.id + ".json"), "utf8"));
  assert.equal(saved.raw.length, 3);
  assert.equal(saved.spentUsd, completed.spentUsd);
  assert.deepEqual(openResearch(dir, connectors, client, () => new Date(Date.parse(completed.retrievedAt) + 31 * 86_400_000)).submit(input),
    { ...completed, stale: true });
  assert.equal(calls.length, 3);
});

test("다른 판본·없는 인용·잘못된 값과 단위를 버리고 나머지 주장과 미확인 배선을 살린다", async t => {
  const dir = await dataDir(t);
  const connectors = openLibrary(root, dir).describe().connectors;
  const { client } = fixtureClient([recording.identify, recording.investigate, recording.normalized]);
  const research = openResearch(dir, connectors, client, () => new Date("2026-11-27T00:01:00Z"));
  const ready = await settled(research, research.submit(input));
  const result = await settled(research, research.submit(choose(ready)));
  assert.equal(result.phase, "complete");
  const { model, discarded, conflicts } = result.draft!;
  assert.deepEqual(model.ports.map(port => port.id), ["a"]);
  assert.deepEqual(model.ports[0]!.attachment, {
    value: null, unit: "", condition: "", confidence: "unknown", sources: ["source-1"],
  });
  assert.equal(model.ports[0]!.connector.value, "usb-c-receptacle");
  const params = model.ports[0]!.interfaces[0]!.params;
  assert.deepEqual(Object.keys(params).sort(), ["accepts5", "maxW", "pdo5"]);
  assert.equal(params.accepts5!.value, false);
  assert.equal(params.maxW!.value, 30);
  assert.equal(params.pdo5!.value, 3);
  assert.deepEqual(conflicts, []);
  assert(!model.sources.some(source => source.locator.endsWith("fa-25")));
  assert(model.sources.every(source => source.retrievedAt === "2026-11-27"));
  assert.equal(model.edges.length, 0);
  assert.equal(model.resources[0]!.capacity.value, null);
  assert(discarded.some(message => message.includes("인용 근거")));
  assert(discarded.some(message => message.includes("별도 근거")));
  assert(discarded.some(message => message.includes("reserveW") || message.includes("claims.")));
  assert(discarded.some(message => message.includes("accepts9")));
});

test("같은 판본의 충돌값마다 출처를 저장하고 본값에서 단위와 조건을 공통으로 읽는다", async t => {
  const dir = await dataDir(t);
  const connectors = openLibrary(root, dir).describe().connectors;
  const { client } = fixtureClient([recording.identify, recording.investigate, recording.conflicting]);
  const research = openResearch(dir, connectors, client);
  const ready = await settled(research, research.submit(input));
  const result = await settled(research, research.submit(choose(ready)));
  assert.equal(result.phase, "complete");
  const { conflicts, model } = result.draft!;
  assert.deepEqual(conflicts[0]?.values.map(item => [item.value, item.sources]), [[30, ["source-1"]], [60, ["detail-source-2"]]]);
  const fact = model.ports[0]?.interfaces[0]?.params.maxW;
  assert.equal(fact?.value, 30);
  assert.equal(fact.unit, "W");
  assert.deepEqual(fact.conflicts, [{ value: 60, confidence: "review", sources: ["detail-source-2"] }]);
});

test("예산을 넘길 다음 호출은 실행하지 않고 이미 확인한 판본과 출처를 둔다", async t => {
  const dir = await dataDir(t);
  const connectors = openLibrary(root, dir).describe().connectors;
  const costly = oneCandidate();
  costly.usage.input_tokens = 240_000;
  const { calls, client } = fixtureClient([costly]);
  const research = openResearch(dir, connectors, client);
  const result = await settled(research, research.submit(input));
  assert.equal(result.stop, "budget");
  assert.equal(calls.length, 1);
  assert.equal(result.draft?.model.revision, "FA-24");
  assert.equal(result.draft?.model.ports.length, 0);
  assert(result.sources.length);
  assert(result.spentUsd > 0);
});

test("pause_turn은 멈춘 응답을 그대로 이어 보내고 refusal 뒤에는 정규화하지 않는다", async t => {
  const dir = await dataDir(t);
  const connectors = openLibrary(root, dir).describe().connectors;
  const paused = structuredClone(recording.investigate);
  paused.stop_reason = "pause_turn";
  const refused = structuredClone(recording.investigate);
  refused.stop_reason = "refusal";
  refused.content = [];
  const { calls, client } = fixtureClient([oneCandidate(), paused, refused]);
  const research = openResearch(dir, connectors, client);
  const result = await settled(research, research.submit(input));
  assert.equal(result.stop, "refusal");
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2]!.messages, [calls[1]!.messages[0], { role: "assistant", content: paused.content }]);
  assert.deepEqual(calls[2]!.tools, calls[1]!.tools);
  assert(result.sources.some(row => row.locator.includes("review.")));
  assert.equal(result.draft?.model.ports.length, 0);
});

test("키 없음과 같은 출처 검사는 서버 경계에서 유료 호출을 막는다", async t => {
  const dir = await dataDir(t);
  const server = await startServer({ port: 0, dataDir: dir, researchClient: null });
  t.after(() => new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done())));
  const address = server.address();
  assert(address && typeof address === "object");
  const origin = "http://127.0.0.1:" + address.port;
  const config = await (await fetch(origin + "/api/research")).json();
  assert.deepEqual(config, { enabled: false, budgetUsd: 5, maxSearches: 6, cacheDays: 30 });
  const send = (originHeader: string) => fetch(origin + "/api/research", { method: "POST",
    headers: { "Content-Type": "application/json", Origin: originHeader }, body: JSON.stringify(input) });
  assert.equal((await send("https://unrelated.example.com")).status, 403);
  const missing = await send(origin);
  assert.equal(missing.status, 403);
  assert.match((await missing.json() as { message: string }).message, /ANTHROPIC_API_KEY/);
});

test("공개 URL에서 비공개 매개변수를 제거하고 내부 주소와 여분 필드를 받지 않는다", async t => {
  const dir = await dataDir(t);
  const connectors = openLibrary(root, dir).describe().connectors;
  const { calls, client } = fixtureClient([oneCandidate(), recording.investigate, recording.normalized]);
  const research = openResearch(dir, connectors, client);
  for (const query of ["http://127.0.0.1/product", "http://[::1]/product", "http://server.local/product", "https://user:password@site.example.com/p"])
    assert.throws(() => research.submit({ action: "start", query }), /공용 웹사이트/);
  assert.throws(() => research.submit({ ...input, scene: {} }), /Unrecognized key/);
  assert.equal(calls.length, 0);
  const result = research.submit({ action: "start", query: "https://manufacturer.example.com/product?sku=FA-24&token=private#panel" });
  const sent = JSON.parse(calls[0]!.messages[0]!.content as string) as { query: string };
  assert.equal(sent.query, "https://manufacturer.example.com/product?sku=FA-24");
  assert.equal((await settled(research, result)).phase, "complete");
});
