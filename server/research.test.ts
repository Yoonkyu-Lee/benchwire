// 가상 응답으로 판본·인용·예산·캐시 경계를 검증한다.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { fixtureClient, recording } from "../fixtures/research/recording.ts";
import { plugins } from "../domains/registry.ts";
import { evaluate } from "../engine/evaluate.ts";
import { loadSceneDocuments } from "../scene/load.ts";
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
  const completed = await research.waitFor(result.id);
  assert(!pending(completed));
  return completed;
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
  assert.equal(reopened.submit(choose(result)).id, approved.id);
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
  assert.equal(saved.raw.length, 2);
  const identity = JSON.parse(await readFile(join(dir, "research", result.id + ".json"), "utf8"));
  assert.equal(identity.raw.length, 1);
  assert.equal(saved.spentUsd, completed.spentUsd);
  const aged = openResearch(dir, connectors, client, () => new Date(Date.parse(completed.retrievedAt) + 31 * 86_400_000)).submit(input);
  assert.deepEqual(aged, { ...result, stale: true });
  assert.equal(calls.length, 3);
});

test("판본·출처·스키마가 맞는 주장과 배선은 확인해야 할 초안으로 남긴다", async t => {
  const dir = await dataDir(t);
  const connectors = openLibrary(root, dir).describe().connectors;
  const { client } = fixtureClient([recording.identify, recording.investigate, recording.normalized]);
  const research = openResearch(dir, connectors, client, () => new Date("2026-11-27T00:01:00Z"));
  const ready = await settled(research, research.submit(input));
  const result = await settled(research, research.submit(choose(ready)));
  assert.equal(result.phase, "complete");
  const { model, discarded, proposals } = result.draft!;
  assert.deepEqual(model.ports.map(port => port.id), ["a"]);
  assert.deepEqual(model.ports[0]!.attachment, {
    value: null, unit: "", condition: "", confidence: "unknown", sources: ["source-1"],
  });
  assert.equal(model.ports[0]!.connector.value, null);
  assert(proposals.claims.some(row => row.field === "connector" && row.claim.value === "c-receptacle"));
  const params = model.ports[0]!.interfaces[0]!.params;
  assert.equal(params.accepts9!.value, null);
  assert.equal(params.reserveW!.value, null);
  assert.equal(params.accepts5!.value, null);
  assert.equal(params.maxW!.value, null);
  assert.equal(params.pdo5!.value, null);
  assert(proposals.claims.some(row => row.field === "accepts5" && row.claim.value === false));
  assert(proposals.claims.some(row => row.field === "pdo5" && row.claim.value === 3));
  assert.deepEqual(proposals.definitions.map(row => row.target), ["node", "node", "port", "interface", "resource"]);
  assert(!model.sources.some(source => source.locator.endsWith("fa-25")));
  assert(model.sources.every(source => source.retrievedAt === "2026-11-27"));
  assert.equal(model.edges.length, 0);
  assert.equal(model.resources[0]!.capacity.value, null);
  assert(discarded.some(message => message.includes("인용 근거")));
  assert(proposals.claims.some(row => row.field === "maxW" && row.claim.value === 15 && row.claim.condition === "other load condition"));
  assert(discarded.some(message => message.includes("reserveW") || message.includes("claims.")));
  assert(discarded.some(message => message.includes("accepts9")));
});

test("충돌한 조사 값은 각 출처와 경고를 가진 확인 전 제안이다", async t => {
  const dir = await dataDir(t);
  const connectors = openLibrary(root, dir).describe().connectors;
  const { client } = fixtureClient([recording.identify, recording.investigate, recording.conflicting]);
  const research = openResearch(dir, connectors, client);
  const ready = await settled(research, research.submit(input));
  const result = await settled(research, research.submit(choose(ready)));
  assert.equal(result.phase, "complete");
  const { proposals, model } = result.draft!;
  const claims = proposals.claims.filter(row => row.field === "maxW" && !row.claim.condition);
  assert.deepEqual(claims.map(row => [row.claim.value, row.claim.sources]), [[30, ["source-1"]], [60, ["detail-source-2"]]]);
  assert(claims.every(row => row.reason.includes("다른 제안")));
  const fact = model.ports[0]?.interfaces[0]?.params.maxW;
  assert.equal(fact?.value, null);
  assert.equal(fact.unit, "W");
  assert.equal(fact.conflicts, undefined);
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



function withOfficialQuote(extra: string, changeDocument = true) {
  const message = structuredClone(recording.investigate);
  const fetched = message.content.find(row => row.type === "web_fetch_tool_result" && row.tool_use_id === "fixture-fetched-0");
  assert(fetched?.type === "web_fetch_tool_result" && fetched.content.type === "web_fetch_result"
    && fetched.content.content.source.type === "text");
  const citations = message.content.find(row => row.type === "text")!.citations!;
  const quote = citations[0]!;
  assert.equal(quote.type, "char_location");
  const end = quote.end_char_index;
  quote.cited_text += extra;
  quote.end_char_index += extra.length;
  if (changeDocument) {
    const source = fetched.content.content.source;
    source.data = source.data.slice(0, end) + extra + source.data.slice(end);
    for (const row of citations) {
      if (row.type !== "char_location" || row.document_index !== quote.document_index || row.start_char_index < end) continue;
      row.start_char_index += extra.length;
      row.end_char_index += extra.length;
    }
  }
  return message;
}

test("인용의 30 W를 99 W로 바꾼 정규화 값은 경고 있는 확인 전 제안이다", async t => {
  const dir = await dataDir(t);
  const connectors = openLibrary(root, dir).describe().connectors;
  const normalized = structuredClone(recording.normalized);
  const text = normalized.content.find(row => row.type === "text")!;
  const doc = JSON.parse(text.text);
  doc.claims = doc.claims.filter((claim: { value: unknown }) => claim.value !== 15);
  doc.claims.find((claim: { value: unknown }) => claim.value === 30).value = 99;
  text.text = JSON.stringify(doc);
  const found = withOfficialQuote(" 199 W. 99 mW. 99 W is not supported.");
  const { client } = fixtureClient([recording.identify, found, normalized]);
  const research = openResearch(dir, connectors, client);
  const result = await settled(research, research.submit(choose(await settled(research, research.submit(input)))));
  assert.equal(result.draft!.model.ports[0]!.interfaces[0]!.params.maxW!.value, null);
  assert.match(result.draft!.proposals.claims.find(row => row.field === "maxW")!.reason, /값·단위·조건/);
});



function officialContext(quote: string, before = "", after = "", codePoints = false) {
  const found = structuredClone(recording.investigate);
  const fetch = found.content.find(row => row.type === "web_fetch_tool_result" && row.tool_use_id === "fixture-fetched-0");
  assert(fetch?.type === "web_fetch_tool_result" && fetch.content.type === "web_fetch_result" && fetch.content.content.source.type === "text");
  const citation = found.content.find(row => row.type === "text")!.citations![0]!;
  assert.equal(citation.type, "char_location");
  const length = (value: string) => codePoints ? [...value].length : value.length;
  citation.cited_text = quote;
  citation.start_char_index = length(before);
  citation.end_char_index = length(before + quote);
  fetch.content.content.source.data = before + quote + after;
  return found;
}

const maxPowerQuote = "Morrow Finch FA-24. USB-C A: maxW: 99 W.";
const pdoListQuote = "Morrow Finch FA-24. USB-C A: All source PDOs: 5 V / 3 A, 9 V / 2 A.";

test("적대적 인용 변형은 미확인으로 두고 값과 PDO 생략의 개별 확인을 요구한다", async t => {
  const dir = await dataDir(t);
  const connectors = openLibrary(root, dir).describe().connectors;
  const distant = "\n\n" + "제품 설명 ".repeat(110) + "\n";
  const cases = [
    { name: "다른 포트", quote: " USB-C A 30 W, USB-C B 99 W.", secondPort: true },
    { name: "영어 조건", quote: " USB-C A: 99 W only when a single port is in use." },
    { name: "한국어 조건", quote: " USB-C A는 한 포트만 연결했을 때 99 W." },
    { name: "부정문", quote: " USB-C A: 99 W is not supported." },
    { name: "다른 단위", quote: " USB-C A: 99 mW." },
    { name: "다른 판본", quote: "", citation: "quote-3" },
    { name: "같은 문서의 미식별 판본", quote: "\nMorrow Finch FA-26. USB-C A: maxW: 99 W.", citation: "quote-7", splitQuote: true },
    { name: "다른 포트의 전체 PDO", quote: "\nUSB-C A and USB-C B.\nAll source PDOs: 5 V / 3 A, 9 V / 2 A", secondPort: true, omission: true },
    { name: "출처 둘의 같은 값", quote: "", replace: "Morrow Finch FA-24. USB-C A: maxW: 99 W.", duplicate: true },
    { name: "정규화가 대상과 조건을 비움", quote: " Only USB-C B can deliver 99 W when used alone.",
      unlabeled: true },
    { name: "정규화가 경쟁 포트를 누락", quote: " USB-C A, USB-C B 99 W." },
    { name: "조건부 PDO 목록", quote: "\nUSB-C A only when used alone.\nUSB-C A: All source PDOs: 5 V / 3 A, 9 V / 2 A", omission: true },
    { name: "같은 포트의 모순되는 PDO 목록", quote: "\nUSB-C A: All source PDOs: 5 V / 3 A\nUSB-C A: All source PDOs: 20 V / 3 A", omission: true },
    { name: "포트 수에 따른 99 W와 30 W", quote: maxPowerQuote + " 1-port operation: 99 W. 2-port operation: 30 W.", otherValue: true },
    { name: "비교값 순서가 다른 인용", quote: "Morrow Finch FA-24. 2-port operation: 30 W. USB-C A: maxW: 99 W. 1-port operation: 99 W.", otherValue: true },
    { name: "공백 없는 수량", quote: "Morrow Finch FA-24. USB-C A: maxW: 99W. 2-port operation: 30W.", otherValue: true },
    { name: "인용 바로 뒤의 다른 값", quote: maxPowerQuote, after: "\n2-port operation: 30 W.", otherValue: true },
    { name: "유니코드 문자 인덱스 인용 앞의 다른 값", quote: maxPowerQuote, before: "📟 2-port operation: 30W. ", codePoints: true, otherValue: true },
    { name: "열 제목에 단위를 둔 비교표", quote: maxPowerQuote, after: "\n| Ports used | Max W |\n| --- | --- |\n| 1 | 99 |\n| 2 | 30 |", otherValue: true },
    { name: "인용에 20 V가 있는 완전 목록", quote: pdoListQuote + " 1-port operation: 20 V / 3 A.", omission: true, nearbyPdo: true },
    { name: "20 V가 목록 선언보다 먼저 나옴", quote: "Morrow Finch FA-24. 1-port operation: 20V / 3A. USB-C A: All source PDOs: 5 V / 3 A, 9 V / 2 A.", omission: true, nearbyPdo: true },
    { name: "인용에서 먼 문단의 다른 전력값", quote: maxPowerQuote, after: distant + "2-port operation: 30 W.", otherValue: true },
    { name: "다른 단위로 쓴 전력값", quote: maxPowerQuote + " 1-port operation: 99,000 mW. 2-port operation: 30,000 mW (0.030 kW).", otherValue: true },
    { name: "풀어 쓴 단위가 있는 표", quote: maxPowerQuote, after: "\n| Ports used | Output (Watts) |\n| --- | --- |\n| 1 | 99 |\n| 2 | 30 |", otherValue: true },
    { name: "탭 표", quote: maxPowerQuote, after: "\nPorts used\tOutput (W)\n1\t99\n2\t30", otherValue: true },
    { name: "숫자 없는 조건문", quote: maxPowerQuote, after: " Available exclusively in standalone operation.", context: true },
    { name: "인용 바로 뒤 표에 20 V가 있음", quote: pdoListQuote, after: "\nPorts used | Voltage (V)\n1 | 20", omission: true, nearbyPdo: true },
    { name: "인용에서 먼 문단의 20 V", quote: pdoListQuote, after: distant + "1-port operation: 20 V / 3 A.", omission: true, nearbyPdo: true },
    { name: "밀리볼트로 쓴 20 V", quote: pdoListQuote + " 1-port operation: 20,000 mV / 3 A.", omission: true, nearbyPdo: true },
    { name: "밀리볼트 표의 20 V", quote: pdoListQuote, after: "\n| Ports used | Voltage (mV) |\n| --- | --- |\n| 1 | 20,000 |", omission: true, nearbyPdo: true },
  ];
  for (const variant of cases) await t.test(variant.name, async child => {
    const isolated = await dataDir(child);
    const found = variant.otherValue || variant.nearbyPdo || variant.context
      ? officialContext(variant.quote, variant.before, variant.after, variant.codePoints)
      : withOfficialQuote(variant.quote);
    if (variant.splitQuote) {
      const citations = found.content.find(row => row.type === "text")!.citations!;
      const first = citations[0]!;
      assert.equal(first.type, "char_location");
      const start = first.end_char_index - variant.quote.length;
      citations.push({ ...first, cited_text: variant.quote, start_char_index: start });
      first.cited_text = first.cited_text.slice(0, start);
      first.end_char_index = start;
    }
    if (variant.replace) {
      for (const index of [0, 1]) {
        const fetch = found.content.find(row => row.type === "web_fetch_tool_result" && row.tool_use_id === "fixture-fetched-" + index);
        assert(fetch?.type === "web_fetch_tool_result" && fetch.content.type === "web_fetch_result" &&
          fetch.content.content.source.type === "text");
        const citation = found.content.find(row => row.type === "text")!.citations![index]!;
        assert.equal(citation.type, "char_location");
        citation.cited_text = variant.replace;
        citation.end_char_index = citation.cited_text.length;
        fetch.content.content.source.data = citation.cited_text;
      }
    }
    const normalized = structuredClone(recording.normalized);
    const text = normalized.content.find(row => row.type === "text")!;
    const doc = JSON.parse(text.text);
    const claim = { ...doc.claims.find((row: { field: string }) => row.field === "maxW"), value: 99, citation: variant.citation ?? "quote-1" };
    doc.claims = variant.omission ? [] : [claim];
    doc.ports = doc.ports.slice(0, 1);
    if (variant.secondPort) doc.ports.push({ id: "b", label: "USB-C B", citation: "quote-1" });
    if (variant.unlabeled) doc.ports[0].label = "port";
    if (variant.duplicate) doc.claims.push({ ...claim, citation: "quote-2", confidence: "review" });
    doc.omissions = variant.omission ? [{ target: "interface", id: "usb-a", domain: "power", field: "pdo20", citation: "quote-1" }] : [];
    text.text = JSON.stringify(doc);
    const { client } = fixtureClient([oneCandidate(), found, normalized]);
    const research = openResearch(isolated, connectors, client);
    const result = await settled(research, research.submit(input));
    assert.equal(result.phase, "complete", result.stop ?? "");
    const draft = result.draft!;
    const params = draft.model.ports.find(port => port.id === "a")?.interfaces[0]?.params;
    assert.equal(params?.maxW?.value, null);
    assert.equal(params.pdo20?.value, null);
    if (variant.omission) {
      assert.equal(draft.proposals.omissions.length, 1);
      const omission = draft.proposals.omissions[0]!;
      assert.equal(omission.field, "pdo20");
      assert(omission.reason);
      if (variant.nearbyPdo) assert.match(omission.reason, /20 V/);
    } else if (variant.citation === "quote-3") {
      assert.deepEqual(draft.proposals.claims, []);
      assert(draft.discarded.some(row => row.includes("maxW")));
    } else {
      const matches = draft.proposals.claims.filter(row => row.field === "maxW" && row.claim.value === 99);
      assert.equal(matches.length, variant.duplicate ? 2 : 1);
      for (const proposal of matches) {
        assert(proposal.reason);
        if (variant.otherValue) assert.match(proposal.reason, /같은 문서에 다른 값.*30 W/);
        if (variant.context) assert.match(proposal.reason, /조건이 붙은 값/);
        assert.equal(proposal.claim.sources.length, 1);
      }
    }
  });
});

test("같은 값의 환산 표기와 다른 양·다른 포트가 있어도 일괄 확인할 수 있다", async t => {
  const dir = await dataDir(t);
  const connectors = openLibrary(root, dir).describe().connectors;
  const normalized = structuredClone(recording.normalized);
  const text = normalized.content.find(row => row.type === "text")!;
  const doc = JSON.parse(text.text);
  doc.claims = [{ ...doc.claims.find((row: { field: string }) => row.field === "maxW"), value: 99 }];
  doc.ports = [{ id: "a", label: "USB-C A", citation: "quote-1" }, { id: "b", label: "USB-C B", citation: "quote-1" }];
  text.text = JSON.stringify(doc);
  const found = officialContext(maxPowerQuote, "내용 ".repeat(200) + "\n\n",
    " 99.0 W. 99,000 mW. 0.099 kW. 12 V. USB-C B: maxW: 30 W.\r\n| Port | Max. W |\r\n| USB-C A | 99 |\r\n| USB-C B | 42 |\r\n\r\nUSB-C B: maxW: 50 W.");
  const { client } = fixtureClient([oneCandidate(), found, normalized]);
  const research = openResearch(dir, connectors, client);
  const result = await settled(research, research.submit(input));
  assert.equal(result.phase, "complete", result.stop ?? "");
  const { model, proposals } = result.draft!;
  assert.equal(model.ports[0]?.interfaces[0]?.params.maxW?.value, null);
  assert.deepEqual(proposals.claims.find(row => row.field === "maxW")?.claim,
    { value: 99, unit: "W", condition: "", confidence: "official", sources: ["source-1"] });
  assert.equal(proposals.claims.find(row => row.field === "maxW")?.reason, "");
});

test("전송률 단위를 환산해 같은 양을 구별하기 전에도 모두 초안으로 남긴다", async t => {
  const identify = oneCandidate();
  const identity = identify.content.find(row => row.type === "text")!;
  const candidates = JSON.parse(identity.text);
  candidates[0].domains = ["data"];
  identity.text = JSON.stringify(candidates);
  const normalized = structuredClone(recording.normalized);
  const text = normalized.content.find(row => row.type === "text")!;
  const doc = JSON.parse(text.text);
  doc.ports = doc.nodes = doc.interfaces = doc.edges = [];
  doc.resources = [{ id: "transfer", label: "Transfer", kind: "total", domain: "data", unit: "MB/s", citation: "quote-1" }];
  doc.claims = [{ target: "resource", id: "transfer", field: "capacity", domain: "data", unit: "MB/s", value: 500,
    citation: "quote-1", confidence: "official", condition: "" }];
  text.text = JSON.stringify(doc);
  for (const same of [true, false]) {
    const dir = await dataDir(t);
    const quote = "Morrow Finch FA-24. Transfer: capacity: 500 MB/s.";
    const found = officialContext(quote, "", same ? "\nTransfer capacity: 0.5 GB/s." : "\nTransfer capacity: 0.25 GB/s.");
    const { client } = fixtureClient([identify, found, normalized]);
    const connectors = openLibrary(root, dir).describe().connectors;
    const research = openResearch(dir, connectors, client);
    const draft = (await settled(research, research.submit(input))).draft!;
    assert.equal(draft.model.resources[0]?.capacity.value, null);
    const proposal = draft.proposals.claims[0]!;
    assert.equal(proposal.claim.value, 500);
    if (same) assert.equal(proposal.reason, "");
    else assert.match(proposal.reason, /다른 값.*250 MB\/s/);
  }
});

test("인용 메타데이터에만 있는 구간을 실제 열람 본문으로 취급하지 않는다", async t => {
  const dir = await dataDir(t);
  const connectors = openLibrary(root, dir).describe().connectors;
  const { client } = fixtureClient([oneCandidate(), withOfficialQuote(" Fake appended quote.", false), recording.normalized]);
  const research = openResearch(dir, connectors, client);
  const result = await settled(research, research.submit(input));
  assert.equal(result.draft!.model.ports.length, 0);
  assert(result.draft!.discarded.some(row => row.includes("검증된 인용")));
});

test("연결되지 않았다는 원문으로 부착을 자동 저장하지 않는다", async t => {
  const dir = await dataDir(t);
  const connectors = openLibrary(root, dir).describe().connectors;
  const { client } = fixtureClient([recording.identify, recording.investigate, recording.normalized]);
  const research = openResearch(dir, connectors, client);
  const result = await settled(research, research.submit(choose(await settled(research, research.submit(input)))));
  assert.equal(result.draft!.model.ports[0]!.attachment.value, null);
  assert.deepEqual(result.draft!.model.edges, []);
  assert.match(result.draft!.proposals.attachments[0]!.quote, /are not connected/);
  assert(result.draft!.proposals.attachments[0]!.reason);
  assert.equal(result.draft!.proposals.edges[0]!.uses[0]!.resource, "supply");
});

test("다른 포트의 전체 목록으로 미지원 처리하지 않고 PDO 확인 퀘스트를 남긴다", async t => {
  const dir = await dataDir(t);
  const connectors = openLibrary(root, dir).describe().connectors;
  const normalized = structuredClone(recording.normalized);
  const text = normalized.content.find(row => row.type === "text")!;
  const doc = JSON.parse(text.text);
  doc.ports.push({ id: "b", label: "USB-C B", citation: "quote-1" });
  doc.omissions = [{ target: "interface", id: "usb-a", domain: "power", field: "pdo20", citation: "quote-1" }];
  text.text = JSON.stringify(doc);
  const found = withOfficialQuote("\nUSB-C B: All source PDOs: 5 V / 3 A, 9 V / 2 A");
  const { client } = fixtureClient([oneCandidate(), found, normalized]);
  const research = openResearch(dir, connectors, client);
  const result = await settled(research, research.submit(input));
  const pdo = result.draft!.model.ports[0]!.interfaces[0]!.params.pdo20;

  assert.deepEqual([pdo?.value, pdo?.confidence, pdo?.unit], [null, "unknown", "A"]);
  const library = openLibrary(root, dir).describe();
  const model = result.draft!.model;
  model.ports[0]!.connector = { value: "c-receptacle", unit: "", condition: "", confidence: "inferred", sources: ["source-1"] };
  const scene = { sceneId: "pdo-check", sources: [{ id: "fixture", title: "시험", locator: "fixture:pdo", retrievedAt: "2026-11-27" }],
    items: [{ instanceId: "src", modelId: model.modelId, revision: model.revision },
      { instanceId: "sink", modelId: "receiver", revision: "1" }, { instanceId: "cable", modelId: "cable-3a", revision: "1" }],
    connections: [{ id: "usb", from: { instanceId: "src", id: "a" }, to: { instanceId: "sink", id: "in" },
      evidence: { value: true, sources: ["fixture"], confidence: "inferred" },
      parts: [{ instanceId: "cable", entry: "first", exit: "second" }] }], workloads: [], scenarios: [] };
  const models = new Map([...library.models, model].map(row => [row.modelId + "@" + row.revision, row]));
  const loaded = loadSceneDocuments(scene, { models, connectors }, plugins);
  const assessment = evaluate(loaded, plugins);
  assert(assessment.outcomes.some(row => row.domain === "power" && row.verdict === "unknown"));
  assert(assessment.quests.some(quest => loaded.claims[quest.claim]?.field === "pdo20"));
});

test("완전한 PDO 목록의 미지원 제안도 사용자 확인 전에는 미확인이다", async t => {
  const dir = await dataDir(t);
  const connectors = openLibrary(root, dir).describe().connectors;
  const normalized = structuredClone(recording.normalized);
  const text = normalized.content.find(row => row.type === "text")!;
  const doc = JSON.parse(text.text);
  doc.omissions = ["pdo20", "pdo5", "accepts20"].map(field =>
    ({ target: "interface", id: "usb-a", domain: "power", field, citation: "quote-1" }));
  text.text = JSON.stringify(doc);
  const found = officialContext(pdoListQuote);
  const { client } = fixtureClient([oneCandidate(), found, normalized]);
  const research = openResearch(dir, connectors, client);
  const result = await settled(research, research.submit(input));
  const draft = result.draft!;
  const params = draft.model.ports[0]!.interfaces[0]!.params;
  assert.equal(params.pdo20!.value, null);
  assert.equal(params.pdo5!.value, null);
  assert.equal(params.accepts20!.value, null);
  const missing = draft.proposals.omissions.find(row => row.field === "pdo20")!;
  assert.match(missing.quote, /All source PDOs/);
  assert.equal(missing.source, "source-1");
  assert.equal(missing.reason, "");
  assert(draft.proposals.omissions.find(row => row.field === "pdo5")?.reason);
  assert(draft.proposals.omissions.find(row => row.field === "accepts20")?.reason);
});

test("한 이름에서 판본 두 개를 순서대로 조사하고 각 결과를 다시 연다", async t => {
  const dir = await dataDir(t);
  const connectors = openLibrary(root, dir).describe().connectors;
  const normalized = structuredClone(recording.normalized);
  normalized.content.find(row => row.type === "text")!.text = JSON.stringify({
    revision: "FA-25", sources: [{ id: "source-2", confidence: "official" }],
    ports: [{ id: "b", label: "USB-C B", citation: "quote-3" }], nodes: [], edges: [], resources: [],
    interfaces: [{ id: "usb-b", label: "USB PD", port: "b", domain: "power", protocol: "USB PD", role: "source", citation: "quote-3" }],
    claims: [{ target: "interface", id: "usb-b", domain: "power", field: "maxW", condition: "", value: 99, unit: "W",
      citation: "quote-3", confidence: "official" }], omissions: [],
  });
  const { calls, client } = fixtureClient([recording.identify, recording.investigate, recording.normalized, recording.investigate, normalized]);
  const research = openResearch(dir, connectors, client);
  const first = await settled(research, research.submit(input));
  const a = await settled(research, research.submit(choose(first)));
  const again = research.submit(input);
  assert.equal(again.phase, "choosing");
  const b = await settled(research, research.submit(choose(again, 1)));
  assert.notEqual(a.id, b.id);
  assert.equal(b.draft?.model.revision, "FA-25");
  assert.equal(b.draft?.model.ports[0]?.interfaces[0]?.params.maxW?.value, null);
  assert.equal(b.draft?.proposals.claims.find(row => row.field === "maxW")?.claim.value, 99);
  const reopened = openResearch(dir, connectors, client);
  assert.equal(reopened.submit(choose(again)).id, a.id);
  assert.equal(reopened.submit(choose(again, 1)).id, b.id);
  assert.equal(calls.length, 5);
});

test("완료를 기다리는 HTTP 조회는 단일 판본의 상세 기록까지 돌려준다", async t => {
  const dir = await dataDir(t);
  const { calls, client } = fixtureClient([oneCandidate(), recording.investigate, recording.normalized]);
  const gate = Promise.withResolvers<void>();
  const server = await startServer({ port: 0, dataDir: dir, researchClient: {
    stream(params) {
      const stream = client.stream(params);
      return { async finalMessage() {
        await gate.promise;
        return stream.finalMessage();
      } };
    },
  } });
  t.after(() => new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done())));
  const address = server.address();
  assert(address && typeof address === "object");
  const origin = "http://127.0.0.1:" + address.port;
  const response = await fetch(origin + "/api/research", { method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(input) });
  assert.equal(response.status, 202);
  const initial = await response.json() as ResearchStatus;
  assert.equal(initial.phase, "identifying");
  const path = origin + "/api/research/" + initial.id;
  const progress = await (await fetch(path)).json() as ResearchStatus;
  assert.equal(progress.phase, "identifying");

  const requested = once(server, "request");
  const waiting = fetch(path + "?wait=1");
  await requested;
  gate.resolve();
  const result = await (await waiting).json() as ResearchStatus;
  assert.equal(result.phase, "complete", result.stop ?? "");
  assert.notEqual(result.id, initial.id);
  assert.equal(result.draft?.model.revision, "FA-24");
  assert.equal(calls.length, 3);
  assert.deepEqual(await (await fetch(path)).json(), result);
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
  const result = research.submit({ action: "start", query: "https://manufacturer.example.com/product?sku=FA-24&code=private#panel" });
  const sent = JSON.parse(calls[0]!.messages[0]!.content as string) as { query: string };
  assert.equal(sent.query, "https://manufacturer.example.com/product");
  assert.equal((await settled(research, result)).phase, "complete");
});
