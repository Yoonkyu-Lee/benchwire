// 저장 문서에 적힌 출처 충돌을 로더·후보별 재협상·판정 근거 출력까지 확인한다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { plugins } from "../cli/domains.ts";
import { printResults } from "../cli/print.ts";
import { effectiveClaim } from "../engine/contract.ts";
import { evaluate } from "../engine/evaluate.ts";
import { modelFile } from "../scene/files.ts";
import { loadSceneDocuments } from "../scene/load.ts";

function fixture(folder: string, name: string) {
  const read = (key: string) => JSON.parse(readFileSync(join(import.meta.dirname, folder, key + ".json"), "utf8"));
  const document = read(name), connectors = read("connectors");
  const models = new Map<string, ReturnType<typeof read>>();
  for (const { modelId, revision } of document.items) {
    const key = modelId + "@" + revision;
    if (!models.has(key)) models.set(key, read(key));
  }
  return { document, models, load: () => loadSceneDocuments(document, { models, connectors }, plugins) };
}

function competing(value: number | boolean | string, source: string) {
  return { value, confidence: "review", sources: [source] };
}

test("T8 30·60 W 출처만으로 순충전 −10·20 W와 불가·성립을 증명한다", () => {
  const f = fixture("power", "single-port"), supply = f.models.get("supply@1");
  const capacity = supply.resources[0].capacity;
  Object.assign(capacity, { value: 30, confidence: "official", conflicts: [competing(60, "table")] });
  const request = f.document.workloads[0].request;
  request.loadW.value = 40;
  request.targetW.value = 10;
  const scene = f.load();
  const id = effectiveClaim(scene, "resource", 0, "power", "capacity")!;
  const domains = plugins.map(p => p.id !== "power" ? p : { ...p, negotiate(link: Parameters<typeof p.negotiate>[0]) {
    const c = link.scene.claims[id]!;
    if (c.value !== null) {
      const sourceIds = link.scene.claimSources.filter(s => s.claim === id).map(s => scene.sources[s.source]!.id);
      assert.deepEqual([c.confidence, sourceIds], c.value === 30 ? ["official", ["supply"]] : ["review", ["table"]]);
    }
    return p.negotiate(link);
  } });
  const r = evaluate(scene, domains);
  const row = r.outcomes.findIndex(o => o.subjectKind === "workload");
  assert.equal(scene.claims[id]!.value, null);
  assert.deepEqual(r.errors, []);
  assert.equal(r.outcomes[row]!.verdict, "unknown");
  assert.deepEqual(r.possibleVerdicts.filter(v => v.outcome === row).map(v => v.verdict).sort(), ["impossible", "ok"]);
  const net = r.measures.find(m => m.outcome === row && m.run === "together" && m.kind === "netCharge")!;
  assert.deepEqual([net.low, net.high], [-10, 20]);
  assert.ok(r.quests.some(q => q.outcome === row && q.claim === id && q.impact === "verdict"));
  assert.ok(r.reasonInputs.some(i => r.reasons[i.reason]!.outcome === row && i.claim === id));
  const text = printResults(scene, r).split("\n근거\n")[1]!;
  assert.match(text, /충돌 후보 30 W \[official\][^\n]*\n[^\n]*fixture:power\/supply/u);
  assert.match(text, /충돌 후보 60 W \[review\][^\n]*\n[^\n]*fixture:power\/table/u);

  f.document.personal = [{ instanceId: "supply", ownerKind: "resource", ownerId: "total",
    domain: "power", field: "capacity", claim: { value: 60, unit: "W", confidence: "user_verified", sources: ["scene"] } }];
  const verified = evaluate(f.load(), plugins);
  assert.equal(verified.outcomes.find(o => o.subjectKind === "workload")!.verdict, "ok");
  assert.equal(verified.profileWorlds.length, 0);
});

test("T4 USB4 지원 여부의 두 출처로 PCIe 터널을 양쪽에서 다시 협상한다", () => {
  const f = fixture("data", "scene");
  const cable = f.models.get("usb-cable@1");
  cable.sources.push({ ...cable.sources[0], id: "review", locator: "fixture:usb-review" });
  cable.attributes.data.cableDataGbps.value = 40;
  cable.attributes.data.cableUsb4.conflicts = [competing(true, "review")];
  f.document.workloads[0].kind = "pcie-tunnel";
  const scene = f.load(), r = evaluate(scene, plugins);
  const id = scene.claims.findIndex(c => c.field === "cableUsb4");
  const row = r.outcomes.findIndex(o => o.subjectKind === "workload");
  assert.deepEqual(new Set(r.profileWorlds.filter(w => w.claim === id).map(w => w.value)), new Set([false, true]));
  assert.deepEqual(r.possibleVerdicts.filter(v => v.outcome === row).map(v => v.verdict).sort(), ["impossible", "ok"]);
  assert.ok(r.quests.some(q => q.outcome === row && q.claim === id));
  const metric = r.metrics.find(m => m.outcome === row && m.kind === "together")!;
  assert.deepEqual([metric.low, metric.high], [0, 500]);
  const tunnel = r.outcomes.findIndex(o => o.subjectKind === "connection" && o.direction === "forward" && o.pool?.id === "usb4-tunnel");
  assert.deepEqual(r.possibleVerdicts.filter(v => v.outcome === tunnel).map(v => v.verdict).sort(), ["impossible", "ok"]);
  const limit = r.metrics.find(m => m.outcome === tunnel && m.kind === "limit")!;
  assert.equal(limit.low, 0);
  assert.ok(limit.high! >= 500);
});

test("T2 핀 C·D 출처만 평가하고 다른 조건의 개인 핀과 구별한다", () => {
  const f = fixture("t2", "scene"), host = f.models.get("t2-host@1");
  const pin = host.ports[0].interfaces[0].params.pin;
  host.sources.push({ ...host.sources[0], id: "review" });
  pin.conflicts = [competing("D", "review")];
  const scene = f.load(), r = evaluate(scene, plugins);
  const claim = scene.claims.findIndex(c => c.field === "pin" && c.scope === "model");
  const personal = effectiveClaim(scene, "interface", scene.claims[claim]!.owner, "display", "pin", "dp-2lane")!;
  assert.equal(scene.claims[personal]!.value, "D");
  assert.equal(r.profileWorlds.some(v => v.claim === personal), false);
  assert.deepEqual(new Set(r.profileWorlds.filter(v => v.claim === claim).map(v => v.value)), new Set(["C", "D"]));
  const row = r.outcomes.findIndex(o => o.subjectKind === "workload" && o.domain === "display");
  const metric = r.metrics.find(m => m.outcome === row && m.kind === "together")!;
  assert.deepEqual([r.outcomes[row]!.verdict, metric.low, metric.high], ["conditional", 12.542736, 15.674472]);
  assert.ok(r.quests.some(q => q.outcome === row && q.claim === claim && q.impact === "range"));
});

test("T8 복제한 값의 원본 판본은 JSON 왕복과 판정 근거에 남는다", () => {
  const f = fixture("power", "single-port"), supply = f.models.get("supply@1");
  supply.resources[0].capacity.inferredFrom = "original@rev.2";
  const model = modelFile.parse(JSON.parse(JSON.stringify(modelFile.parse(supply))));
  assert.equal(model.resources[0]!.capacity.inferredFrom, "original@rev.2");
  f.models.set("supply@1", model);
  const scene = f.load(), r = evaluate(scene, plugins);
  assert.match(printResults(scene, r), /capacity = 100 W \[inferred\][^\n]*original@rev\.2/u);
  for (const origin of ["original", "original@1@2", "../original@2"])
    assert.equal(modelFile.safeParse({ ...model, resources: [{ ...model.resources[0]!,
      capacity: { ...model.resources[0]!.capacity, inferredFrom: origin } }] }).success, false);
});

test("T8 충돌은 같은 단위·조건의 알려진 다른 값이며 출처와 값은 필드 경계에서 검증한다", () => {
  const f = fixture("power", "single-port"), supply = f.models.get("supply@1");
  const cap = supply.resources[0].capacity;
  for (const [candidate, field] of [
    [competing(100, "table"), "value"], [competing(-1, "table"), "value"],
    [competing(60, "missing"), "sources"], [{ ...competing(60, "table"), unit: "A" }, "unit"],
    [{ ...competing(60, "table"), condition: "other" }, "condition"],
    [{ ...competing(60, "table"), confidence: "user_verified" }, "confidence"],
  ] as const) {
    cap.conflicts = [candidate];
    assert.throws(f.load, new RegExp("capacity\\.conflicts\\.0\\." + field));
  }
  Object.assign(cap, { value: null, confidence: "unknown", conflicts: [competing(60, "table")] });
  assert.throws(f.load, /capacity\.conflicts/u);
  delete cap.conflicts;
  const pin = supply.ports[0].interfaces[0].params.pdo20;
  pin.conflicts = [competing("bad", "table")];
  assert.throws(f.load, /pdo20\.conflicts\.0\.value/u);
  delete pin.conflicts;
  const attachment = supply.ports[0].attachment;
  attachment.conflicts = [competing("absent-node", "table")];
  assert.throws(f.load, /attachment\.conflicts\.0\.value/u);
});

test("T8 같은 값을 지지하는 출처를 합치고 판본이 다른 주장과 별개로 둔다", () => {
  const f = fixture("power", "single-port"), supply = f.models.get("supply@1");
  const other = structuredClone(supply);
  other.revision = "2";
  other.resources[0].capacity.value = 0;
  f.models.set("supply@2", other);
  f.document.items.push({ instanceId: "v2", modelId: "supply", revision: "2" });
  supply.sources.push({ ...supply.sources[1], id: "third" });
  supply.resources[0].capacity.conflicts = [competing(60, "table"), competing(60, "third")];
  const scene = f.load(), r = evaluate(scene, plugins);
  const [one, two] = scene.claims.flatMap((c,i) => c.ownerKind === "resource" && c.field === "capacity" ? [i] : []);
  assert.equal(scene.claims[two!]!.value, 0);
  assert.deepEqual(new Set(r.profileWorlds.filter(v => v.claim === one).map(v => v.value)), new Set([100, 60]));
  assert.equal(r.profileWorlds.some(v => v.claim === two), false);
  assert.deepEqual(scene.claimSources.filter(s => s.claim === one).map(s => scene.sources[s.source]!.id).sort(),
    ["supply","table","third"]);
});

test("T8 소비 충돌이 판정을 가르고 출력 충돌은 순충전 범위만 바꾼다", () => {
  const f = fixture("power","single-port");
  const cap = f.models.get("supply@1").resources[0].capacity;
  Object.assign(cap, { value: 50, conflicts: [competing(60,"table")] });
  const request = f.document.workloads[0].request;
  request.loadW.conflicts = [competing(70,"scene")];
  request.targetW.value = 10;
  const scene = f.load(), r = evaluate(scene, plugins);
  const row = r.outcomes.findIndex(o => o.subjectKind === "workload");
  const impacts = r.quests.filter(q => q.outcome === row).map(q => [scene.claims[q.claim]!.field, q.impact]);
  assert.deepEqual(impacts.sort(), [["capacity","range"],["loadW","verdict"]]);
});

test("T2 같은 판본의 양 끝은 한 세계에서 같은 USB 모드를 쓰고 실물 측정만 따로 적용한다", () => {
  const f = fixture("data","scene"), host = f.models.get("usb-endpoint@1");
  const modes = host.ports[0].interfaces[0].params.modes;
  Object.assign(modes, { value: "Gen 1x1", conflicts: [competing("Gen 2x2","endpoint")] });
  f.models.get("usb-cable@1").attributes.data.cableDataGbps.value = 20;
  f.document.workloads[0].request.throughput.value = 2500;
  const scene = f.load(), r = evaluate(scene, plugins);
  const row = r.outcomes.findIndex(o => o.subjectKind === "workload");
  assert.deepEqual(r.possibleVerdicts.filter(v => v.outcome === row).map(v => v.verdict), ["conditional"]);
  const m = r.metrics.find(m => m.outcome === row && m.kind === "together")!;
  assert.deepEqual([m.low,m.high],[450,2200]);
  for (const world of [m.lowWorld,m.highWorld]) {
    const ends = r.profileWorlds.filter(v => v.world === world);
    assert.equal(ends.length, 2);
    assert.equal(ends[0]!.value, ends[1]!.value);
  }
  f.document.personal = [{instanceId:"right", ownerKind:"interface", ownerId:"usb", domain:"data", field:"modes",
    claim:{value:"Gen 2x2",confidence:"user_verified",sources:["scene"]}}];
  const personal = evaluate(f.load(), plugins);
  const changed = personal.outcomes.findIndex(o => o.subjectKind === "workload");
  assert.deepEqual(personal.possibleVerdicts.filter(v => v.outcome === changed).map(v => v.verdict).sort(), ["conditional","impossible"]);
});

test("T8 출처 조합 상한을 넘으면 확인하지 않은 판정을 후보 결과로 싣지 않는다", () => {
  const f = fixture("power","single-port"), supply = f.models.get("supply@1");
  supply.resources[0].capacity.conflicts = Array.from({length:256},(_,i) => competing(200 + i,"table"));
  const scene = f.load(), r = evaluate(scene, plugins);
  const row = r.outcomes.findIndex(o => o.subjectKind === "workload");
  assert.equal(r.outcomes[row]!.verdict, "unknown");
  assert.deepEqual(r.possibleVerdicts.filter(v => v.outcome === row), []);
  assert.deepEqual(r.assessments.filter(a => a.outcome === row), []);
  assert.ok(r.quests.some(q => q.outcome === row && scene.claims[q.claim]!.field === "capacity"));
  assert.ok(r.reasons.some(reason => reason.outcome === row && /후보.*상한/u.test(reason.rule)));
});
