// 누락된 케이블 속성이 합성 장면의 범위·퀘스트·출처에 이어지는지 검증한다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { plugins } from "../domains/registry.ts";
import { evaluate } from "../engine/evaluate.ts";
import { modelFile, sceneFile } from "../scene/files.ts";
import { loadSceneDocuments } from "../scene/load.ts";

function fixture(dir: string) {
  const read = (file: string): unknown => JSON.parse(readFileSync(new URL(dir + "/" + file, import.meta.url), "utf8"));
  const document = sceneFile.parse(read("scene.json"));
  const models = new Map(document.items.map(item => {
    const key = item.modelId + "@" + item.revision;
    return [key, modelFile.parse(read(key + ".json"))];
  }));
  return { document, library: { models, connectors: read("connectors.json") } };
}

for (const { dir, modelKey, domain, workload, scenario, expected, fields } of [
  { dir: "network", modelKey: "network-copper@1", domain: "network", workload: "first-hop", scenario: "first-hop",
    expected: "ok", fields: ["category", "length", "screening"] },
  { dir: "t4", modelKey: "t4-usb4-cable@1", domain: "data", workload: "nic-pcie", scenario: "one-video",
    expected: "ok", fields: ["cableDataGbps", "cableUsb4"] },
] as const) test(dir + " 케이블의 속성 그룹 전체가 빠지면 범위와 확인 퀘스트를 낸다", () => {
  const { document, library } = fixture(dir);
  const model = library.models.get(modelKey)!;
  const known = model.attributes[domain]!;
  function run() {
    const scene = loadSceneDocuments(document, library, plugins);
    const result = evaluate(scene, plugins);
    assert.deepEqual(result.errors, []);
    const work = scene.workloads.findIndex(w => w.id === workload);
    const run = scene.scenarios.findIndex(s => s.id === scenario);
    const row = result.outcomes.findIndex(o => o.subjectKind === "workload" && o.subjectRow === work && o.scenario === run);
    assert.ok(row >= 0, workload + " / " + scenario);
    const quests = result.quests.filter(q => q.outcome === row && scene.claims[q.claim]!.domain === domain);
    const metric = result.metrics.find(m => m.outcome === row && m.kind === "together")!;
    return { scene, verdict: result.outcomes[row]!.verdict, quests, metric };
  }

  delete model.attributes[domain];
  const missing = run();
  assert.deepEqual([missing.verdict, [...new Set(missing.quests.map(q => missing.scene.claims[q.claim]!.field))].sort()],
    ["unknown", [...fields].sort()]);
  assert.equal(missing.metric.low, 0);
  assert.ok(missing.metric.high! > 0);
  for (const { claim } of missing.quests) {
    const { value, unit, confidence, field } = missing.scene.claims[claim]!;
    assert.deepEqual([value, unit, confidence], [null, known[field]!.unit, "unknown"]);
    const citation = missing.scene.claimSources.find(row => row.claim === claim);
    assert.equal(missing.scene.sources[citation!.source]!.title, "모델에 값 없음");
  }
  assert.deepEqual(model.attributes[domain], undefined);

  model.attributes[domain] = known;
  const complete = run();
  assert.equal(complete.verdict, expected);
  assert.deepEqual(complete.quests, []);
});

test("이더넷 속성 일부가 빠지면 기존 값과 검증 경계를 지킨다", () => {
  const { document, library } = fixture("network");
  const model = library.models.get("network-copper@1")!;
  const group = model.attributes.network!;
  const length = group.length!;
  delete group.length;
  const scene = loadSceneDocuments(document, library, plugins);
  const item = scene.items.findIndex(i => i.id === "lan-a-wire");
  const fields = scene.claims.filter(c => c.ownerKind === "item" && c.owner === item && c.domain === "network");
  assert.deepEqual(fields.filter(c => c.value === null).map(c => c.field), ["length"]);
  assert.equal(fields.find(c => c.field === "category")!.value, "Cat5e");
  assert.equal(fields.find(c => c.field === "length")!.unit, length.unit);
  group.length = { ...length, unit: "cm" };
  assert.throws(() => loadSceneDocuments(document, library, plugins), /attributes\.network\.length\.unit/);
});

test("인터페이스가 없는 USB 케이블의 개인 검증은 연결을 빼도 다시 열 수 있다", () => {
  const { document, library } = fixture("data");
  const model = library.models.get("usb-cable@1")!;
  delete model.attributes.data;
  const load = () => loadSceneDocuments(document, library, plugins);
  const scene = load();
  const item = scene.items.findIndex(i => i.id === "cable");
  const fields = (scene: ReturnType<typeof load>) => scene.claims.filter(c => c.ownerKind === "item" && c.owner === item && c.domain === "data");
  assert.deepEqual(fields(scene).map(c => [c.field, c.value]), [["cableDataGbps", null], ["cableUsb4", null]]);
  assert.ok(!scene.claims.some(c => c.ownerKind === "item" && c.owner !== item && c.domain === "data"));

  document.personal.push({ instanceId: "cable", ownerKind: "item", ownerId: "cable", domain: "data", field: "cableDataGbps",
    claim: { value: 5, unit: "Gbps", confidence: "user_verified", condition: "", sources: ["scene"] } });
  document.connections.length = 0;
  assert.equal(fields(load()).find(c => c.scope === "personal")?.value, 5);
});
