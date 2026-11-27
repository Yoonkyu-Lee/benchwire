// 저장 문서에 적힌 출처 충돌을 로더·후보별 재협상·판정 근거 출력까지 확인한다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { plugins } from "../cli/domains.ts";
import { printResults } from "../cli/print.ts";
import { effectiveClaim } from "../engine/contract.ts";
import { evaluate } from "../engine/evaluate.ts";
import { availableOption } from "../engine/pools.ts";
import type { Results } from "../engine/results.ts";
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

test("T2 영상 주사율 후보가 같은 연결 설정을 고르는 허브의 범위와 판정을 가른다", () => {
  const f = fixture("t2", "scene");
  f.document.workloads.find((w: {id: string}) => w.id === "video").request.refresh.conflicts = [competing(60, "scene")];
  const scene = f.load(), r = evaluate(scene, plugins);
  const claim = scene.claims.findIndex(c => c.field === "refresh" && c.conflictGroup !== undefined);
  const hub = r.outcomes.findIndex(o => o.subjectKind === "workload" && scene.workloads[o.subjectRow]!.id === "hub");
  const m = r.metrics.find(m => m.outcome === hub && m.kind === "together")!;
  assert.deepEqual([r.outcomes[hub]!.verdict, m.low, m.high], ["unknown", 53.248, 400]);
  assert.deepEqual(r.possibleVerdicts.filter(v => v.outcome === hub).map(v => v.verdict).sort(), ["conditional","ok"]);
  assert.ok(r.quests.some(q => q.outcome === hub && q.claim === claim && q.impact === "verdict"));
  for (const [world, value] of [[m.lowWorld,144],[m.highWorld,60]]) {
    assert.ok(r.profileWorlds.some(v => v.world === world && v.claim === claim && v.value === value));
  }
});

function conflictingUsb() {
  const f = fixture("data","scene"), model = f.models.get("usb-endpoint@1");
  const modes = model.ports[0].interfaces[0].params.modes;
  Object.assign(modes, {value:"High Speed",conflicts:[competing("Gen 1x1","endpoint")]});
  f.models.get("usb-cable@1").attributes.data.cableDataGbps.value = 20;
  f.document.workloads[0].request.throughput.value = 40;
  return f;
}

test("T5 후보에서 생기는 양방향 USB 예산은 역방향 수요와 함께 네 세계에서 검산한다", () => {
  const f = conflictingUsb(), forward = f.document.workloads[0], back = structuredClone(forward);
  Object.assign(back, {id:"return", from:forward.to, to:forward.from});
  Object.assign(back.request.throughput, {value:10,conflicts:[competing(40,"scene")]});
  f.document.workloads.push(back);
  f.document.scenarios[0].members.push("return");
  const scene = f.load(), r = evaluate(scene,plugins);
  const work = r.outcomes.findIndex(o => o.subjectKind === "workload" && o.subjectRow === 0);
  const m = r.metrics.find(m => m.outcome === work && m.kind === "together")!;
  assert.deepEqual([m.low,m.high], [26.624,40]);
  assert.deepEqual(r.possibleVerdicts.filter(v => v.outcome === work).map(v => v.verdict).sort(), ["conditional","ok"]);
  const request = scene.claims.findIndex(c => c.ownerKind === "workload" && c.owner === 1 && c.field === "throughput");
  assert.ok(r.quests.some(q => q.outcome === work && q.claim === request && q.impact === "verdict"));
  const modes = f.models.get("usb-endpoint@1").ports[0].interfaces[0].params.modes;
  delete modes.conflicts;
  delete back.request.throughput.conflicts;
  for (const mode of ["High Speed","Gen 1x1"]) for (const reverse of [10,40]) {
    modes.value = mode;
    back.request.throughput.value = reverse;
    const answer = evaluate(f.load(),plugins);
    const row = answer.outcomes.findIndex(o => o.subjectKind === "workload" && o.subjectRow === 0);
    const congested = mode === "High Speed" && reverse === 40;
    assert.equal(answer.outcomes[row]!.verdict, congested ? "conditional" : "ok");
    assert.equal(answer.metrics.find(m => m.outcome === row && m.kind === "together")!.value, congested ? 26.624 : 40);
  }
});

test("T5 한 후보에서만 생기는 USB 서비스도 양 끝의 출처와 연결 한도를 낸다", () => {
  const f = conflictingUsb(), scene = f.load(), r = evaluate(scene, plugins);
  const rows = r.outcomes.flatMap((o,i) => o.subjectKind === "connection" && o.domain === "data" && o.direction === "forward" ? [i] : []);
  assert.equal(rows.length, 2);
  for (const i of rows) {
    const m = r.metrics.find(m => m.outcome === i && m.kind === "limit")!;
    assert.deepEqual([m.low,m.high,m.unit],[0,r.outcomes[i]!.pool?.id === "usb2-bulk" ? 53.248 : 450,"MB/s"]);
    assert.deepEqual(r.possibleVerdicts.filter(v => v.outcome === i).map(v => v.verdict).sort(),["impossible","ok"]);
    const cited = r.reasonInputs.filter(v => r.reasons[v.reason]!.outcome === i).map(v => v.claim);
    assert.ok(cited.some(id => scene.claims[id]!.field === "modes" && scene.claims[id]!.conflictGroup !== undefined));
  }
});

test("T8 동시 판정이 같아도 단독 충전 판정이 갈리면 판정 퀘스트다", () => {
  const f = fixture("power","three-ports"), model = f.models.get("supply@1");
  model.attributes.power = {};
  Object.assign(model.resources[0].capacity,{value:35,conflicts:[competing(55,"table")]});
  const scene = f.load(), r = evaluate(scene,plugins);
  const row = r.outcomes.findIndex(o => o.subjectKind === "workload" && o.subjectRow === 0 && o.scenario === 0);
  assert.equal(r.outcomes[row]!.verdict,"impossible");
  assert.deepEqual(r.assessments.filter(a => a.outcome === row && a.run === "solo").map(a => a.verdict).sort(),["conditional","ok"]);
  assert.ok(r.quests.some(q => q.outcome === row && scene.claims[q.claim]!.field === "capacity" && q.impact === "verdict"));
});

test("T8 대체 후보도 복제 원본 판본을 저장하고 그 값의 출처에 표시한다", () => {
  const f = fixture("power","single-port"), model = f.models.get("supply@1");
  model.resources[0].capacity.conflicts = [{ ...competing(30,"table"), confidence:"inferred", inferredFrom:"supply@old" }];
  const scene = f.load(), r = evaluate(scene,plugins);
  assert.match(printResults(scene,r),/충돌 후보 30 W \[inferred\] · 원본 supply@old/u);
  model.resources[0].capacity.conflicts[0].confidence = "official";
  assert.throws(f.load,/conflicts\.0\.inferredFrom/u);
});

test("T8 케이블이 먼저 제한하면 출력 충돌의 두 근거를 보존하고 퀘스트는 만들지 않는다", () => {
  const f = fixture("power","single-port"), model = f.models.get("supply@1");
  model.resources[0].capacity.conflicts = [competing(1000,"table")];
  const scene = f.load(), r = evaluate(scene,plugins);
  const cap = scene.claims.findIndex(c => c.field === "capacity"), row = r.outcomes.findIndex(o => o.subjectKind === "workload");
  const m = r.metrics.find(m => m.outcome === row && m.kind === "together")!;
  assert.deepEqual([m.value,m.low,m.high],[60,60,60]);
  assert.equal(r.quests.some(q => q.outcome === row && q.claim === cap), false);
  assert.ok(r.reasonInputs.some(i => i.claim === cap && r.reasons[i.reason]!.outcome === row));
  assert.deepEqual(scene.claimSources.filter(c => c.claim === cap).map(c => [c.candidate?.value,scene.sources[c.source]!.id]),
    [[100,"supply"],[1000,"table"]]);
});

type CandidateField = { value: number | boolean | string; sources: string[];
  conflicts?: ReturnType<typeof competing>[] };
type Axis = [CandidateField, number | boolean | string];
function oracle(f: ReturnType<typeof fixture>, axes: Axis[]) {
  const originals = axes.map(([fact]) => fact.value);
  const worlds = Array.from({length:2 ** axes.length},(_,i) => {
    axes.forEach(([fact,alt],j) => { fact.value = i & (1 << j) ? alt : originals[j]!; delete fact.conflicts; });
    return evaluate(f.load(), plugins);
  });
  axes.forEach(([fact,alt],j) => { fact.value=originals[j]!; fact.conflicts=[competing(alt,fact.sources[0]!)]; });
  const scene = f.load(), merged = evaluate(scene,plugins);
  const claims = axes.map(([fact,alt],j) => scene.claimSources.filter(s => s.candidate?.value === alt &&
    scene.claimSources.some(other => other.claim === s.claim && other.candidate?.value === originals[j] &&
      scene.sources[other.source]!.id === fact.sources[0])).map(s => s.claim));
  function verdicts(r: Results,row: number) {
    return r.possibleVerdicts.filter(v => v.outcome === row).map(v => v.verdict).sort();
  }
  function assessments(r: Results,row: number) {
    return r.assessments.filter(a => a.outcome === row).map(a => [a.run,a.verdict].join("/")).sort();
  }
  for (const r of worlds) for (const o of r.outcomes) {
    assert.ok(merged.outcomes.some(m => m.subjectKind === o.subjectKind && m.subjectRow === o.subjectRow &&
      (m.scenario === o.scenario || o.subjectKind === "connection" && o.scenario === null) &&
      m.direction === o.direction && m.domain === o.domain && m.unit === o.unit && m.pool?.id === o.pool?.id));
  }
  for (const [row,o] of merged.outcomes.entries()) {
    const matches = worlds.map(r => r.outcomes.findIndex(s => s.subjectKind === o.subjectKind && s.subjectRow === o.subjectRow &&
      (s.scenario === o.scenario || s.subjectKind === "connection" && s.scenario === null) && s.direction === o.direction && s.domain === o.domain &&
      s.unit === o.unit && s.pool?.domain === o.pool?.domain && s.pool?.id === o.pool?.id));
    const expected = worlds.map((r,i) => matches[i]! < 0 ? ["impossible"] : verdicts(r,matches[i]!));
    const possible = [...new Set(expected.flat())].sort();
    const label = JSON.stringify([o.subjectKind,o.subjectRow,o.domain,o.scenario,o.direction,o.pool]);
    assert.deepEqual(verdicts(merged,row),possible,label);
    assert.equal(o.verdict,possible.length === 1 ? possible[0] : "unknown",label);
    if (o.subjectKind === "connection") {
      const options = worlds.map((r,i) => {
        const n = r.outcomes[matches[i]!]?.option;
        return n === undefined ? null : availableOption(r,n);
      });
      const identity = (option: typeof options[number]) => option && [option.mode, option.profile, option.unit, option.limit, option.verdict,option.condition,option.bounds,option.pool];
      const identities = options.map(o => JSON.stringify(identity(o)));
      const actual = o.option === undefined ? null : availableOption(merged,o.option);
      assert.deepEqual(identity(actual),identities.every(s => s === identities[0]) ? identity(options[0]!) : null,label);
      if (!actual && options.some(o => o !== null)) {
        const bounds = (side: "low" | "high") => options.map((opt,i) => {
          const index = matches[i]!, result = worlds[i]!;
          if (index < 0 || result.outcomes[index]!.verdict === "impossible") return 0;
          return opt?.limit ?? opt?.bounds?.[side] ?? result.metrics.find(m => m.outcome === index && m.kind === "limit")?.[side] ?? null;
        });
        const lows = bounds("low"), highs = bounds("high");
        const limit = merged.metrics.find(m => m.outcome === row && m.kind === "limit");
        assert.deepEqual([limit?.low,limit?.high],
          [lows.every(n => n !== null) ? Math.min(...lows) : null,highs.every(n => n !== null) ? Math.max(...highs) : null],label);
      }
      continue;
    }
    const metrics = worlds.map((r,i) => r.metrics.filter(m => m.outcome === matches[i]));
    const measures = worlds.map((r,i) => r.measures.filter(m => m.outcome === matches[i]));
    const scores = worlds.map((r,i) => assessments(r,matches[i]!));
    assert.deepEqual(assessments(merged,row), [...new Set(scores.flat())].sort(),label);
    for (const m of metrics.flat()) assert.ok(merged.metrics.some(v => v.outcome === row && v.kind === m.kind && v.unit === m.unit),label);
    for (const m of measures.flat()) {
      const same = (n: typeof m) => n.kind === m.kind && n.unit === m.unit && n.run === m.run;
      const values = measures.map(ms => ms.find(same)), measure = merged.measures.find(n => n.outcome === row && same(n));
      assert.deepEqual([measure?.low,measure?.high],[values.every(v=>v?.low != null) ? Math.min(...values.map(v=>v!.low!)) : null,
        values.every(v=>v?.high != null) ? Math.max(...values.map(v=>v!.high!)) : null],label);
    }
    for (const metric of merged.metrics.filter(m => m.outcome === row)) {
      const values = metrics.map(ms => ms.find(m => m.kind === metric.kind && m.unit === metric.unit));
      const low = values.every(m => m?.low != null) ? Math.min(...values.map(m => m!.low!)) : null;
      const high = values.every(m => m?.high != null) ? Math.max(...values.map(m => m!.high!)) : null;
      assert.deepEqual([metric.low,metric.high],[low,high],label + metric.kind);
    }
    const exact = worlds.map((r,i) => JSON.stringify([r.outcomes[matches[i]!]!.mode,
      metrics[i]!.map(m => [m.kind,m.unit,m.value,m.low,m.high,m.basis]),measures[i]!.map(m=>[m.run,m.kind,m.unit,m.low,m.high])]));
    for (const [j,ids] of claims.entries()) {
      assert.ok(ids.length);
      let impact: string | undefined;
      for (let i=0; i<worlds.length; i++) if (!(i & (1<<j))) {
        const paired = i | (1<<j);
        if (JSON.stringify([expected[i],scores[i]]) !== JSON.stringify([expected[paired],scores[paired]])) { impact="verdict"; break; }
        if (exact[i] !== exact[paired]) impact="range";
      }
      assert.deepEqual([...new Set(merged.quests.filter(q => q.outcome === row && ids.includes(q.claim)).map(q => q.impact))],
        impact ? [impact] : [], label + " · 확인할 주장 " + j);
    }
  }
  const key = (c: Results["choices"][number]) => JSON.stringify([c.scenario,c.connection,c.profile]);
  const common = worlds[0]!.choices.map(key).filter(k => worlds.every(r => r.choices.some(c => key(c) === k)));
  assert.deepEqual(merged.choices.map(key).sort(),common.sort());
  function usage(r: Results) {
    return new Map(r.resourceUsage.map(u => {
      const link = u.resourceKind === "link" ? r.linkResources[u.resource]! : null;
      const pool = link?.service?.poolResource === undefined ? null : r.linkResources[link.service.poolResource]!.pool;
      return [JSON.stringify([u.scenario,u.unit,link ? [link.connection,link.domain,link.pool?.scope === "connection" ? null : link.direction,
        link.pool?.id,link.service?.unit,link.service?.mode,pool?.id] : u.resource]), u];
    }));
  }
  const byWorld = worlds.map(usage), actualUsage = usage(merged);
  for (const id of new Set(byWorld.flatMap(us => [...us.keys()]))) {
    const u = actualUsage.get(id);
    assert.ok(u,id);
    for (const key of ["used","capacity"] as const) {
      const values = byWorld.map(us => us.has(id) ? us.get(id)![key] : 0);
      assert.equal(u[key],values.every(v => v === values[0]) ? values[0] : null,id + key);
    }
  }
  return {scene,merged};
}

test("T4 후보 오라클 · 내부 부착점이 운반 경로를 바꾸는 PCIe 경쟁", () => {
  const f=fixture("t4","scene"), doc=f.document, dock=f.models.get("t4-dock@1");
  const eth=doc.workloads.find((w:{id:string})=>w.id === "ethernet");
  const pcie=doc.workloads.find((w:{id:string})=>w.id === "nic-pcie");
  eth.from={...pcie.from}; eth.request.throughput.value=1200; pcie.request.throughput.value=140;
  dock.ports[0].interfaces[0].params.tunnelGbps.value=1.2;
  doc.scenarios=[{id:"경쟁",members:[eth.id,pcie.id]}];
  const port=dock.ports.find((p:{id:string})=>p.id === "lan");
  const {scene,merged}=oracle(f,[[port.attachment,"storage"]]);
  const row=merged.outcomes.findIndex(o=>o.subjectKind==="workload" && scene.workloads[o.subjectRow]!.id===pcie.id);
  const m=merged.metrics.find(m=>m.outcome===row && m.kind==="together")!;
  assert.deepEqual([m.low,m.high],[75,140]);
});

test("T7 후보 오라클 · PoE 포트 예산 선택과 고정 요청의 우선순위", () => {
  const f=fixture("network","scene"), doc=f.document, pse=f.models.get("network-pse@1");
  const seed=doc.workloads.find((w:{id:string})=>w.id==="poe-12");
  const wire=doc.connections.find((c:{id:string})=>c.id==="poe");
  doc.items=doc.items.filter((x:{instanceId:string})=>["pse","pd","poe-wire"].includes(x.instanceId));
  doc.items.push({...doc.items[1],instanceId:"pd2"},{...doc.items[2],instanceId:"wire2"});
  pse.resources[0].capacity.value=16;
  pse.resources.push({...structuredClone(pse.resources[0]),id:"separate"});
  const port=structuredClone(pse.ports[0]); port.id="pse2";
  for(const iface of port.interfaces) iface.id += "2";
  pse.ports.push(port);
  doc.connections=[wire,{...wire,id:"poe2",from:{...wire.from,id:"pse2"},to:{...wire.to,instanceId:"pd2"},
    parts:[{...wire.parts[0],instanceId:"wire2"}]}];
  doc.workloads=[seed,{...structuredClone(seed),id:"second",to:{...seed.to,instanceId:"pd2"}}];
  doc.scenarios=[{id:"함께",members:[{workload:seed.id,priority:{value:0,confidence:"inferred",sources:["network-scene"]}},"second"]}];
  const {merged}=oracle(f,[[pse.ports[0].interfaces[0].params.budgetResource,"separate"]]);
  const row=merged.outcomes.findIndex(o=>o.subjectKind==="workload" && o.subjectRow===1);
  const m=merged.metrics.find(m=>m.outcome===row && m.kind==="together")!;
  assert.deepEqual([m.low,m.high],[0,12]);
});

test("T2 후보 오라클 · 직접 연결의 두 요청과 핀으로 정한 영상·데이터 설정", () => {
  const f=fixture("t2","scene"), host=f.models.get("t2-host@1");
  oracle(f,[[f.document.workloads[0].request.refresh,60],[f.document.workloads[1].request.throughput,30],
    [host.ports[0].interfaces[0].params.pin,"D"]]);
});

test("T8 후보 오라클 · 상시 부하와 내부 자원 한도", () => {
  const f=fixture("power","passthrough");
  oracle(f,[[f.models.get("relay@1").ports[0].interfaces[0].params.reserveW,22],
    [f.models.get("supply@1").resources[0].capacity,38]]);
});

test("T2 출처 후보 512개인 시나리오는 설정과 선택을 확정할 수 없다", () => {
  const f=fixture("t2","scene"), doc=f.document, video=doc.workloads[0], bulk=doc.workloads[1];
  video.request.refresh.conflicts=[competing(60,"scene")];
  for(let i=0;i<8;i++) {
    const extra=structuredClone(bulk); extra.id="extra-"+i;
    Object.assign(extra.request.throughput,{value:1,conflicts:[competing(2,"scene")]});
    doc.workloads.push(extra); doc.scenarios[0].members.push(extra.id);
  }
  const scene=f.load(), r=evaluate(scene,plugins);
  assert.deepEqual(r.choices,[]);
  assert.deepEqual(r.reservations,[]);
  for(const [row,o] of r.outcomes.entries()) if(o.scenario===0) {
    assert.equal(o.verdict,"unknown");
    assert.equal(o.option,undefined);
    assert.equal(o.path,null);
    assert.deepEqual(r.possibleVerdicts.filter(v=>v.outcome===row),[]);
  }
  assert.doesNotMatch(printResults(scene,r),/^\s*연결 설정 display-hub · /mu);
});

test("T5 후보에만 있는 양방향 예산을 사용량 표와 CLI 제목에서 구별한다", () => {
  const f=conflictingUsb(), scene=f.load(), r=evaluate(scene,plugins);
  const use=r.resourceUsage.find(u=>u.resourceKind==="link" && r.linkResources[u.resource]!.pool?.id==="usb2-bulk");
  assert.ok(use && use.reasonRows.length);
  assert.deepEqual([use.used,use.capacity],[null,null]);
  const titles=printResults(scene,r).split("\n근거\n")[0]!.split("\n").filter(line=>line.includes("연결 usb · left/usb → right/usb"));
  assert.ok(titles.some(line=>line.includes("usb2-bulk")));
  assert.ok(titles.some(line=>!line.includes("usb2-bulk")));
});

test("T5 후보 오라클 · 직결 USB의 양방향 요청과 후보별 공용 예산", () => {
  const f=conflictingUsb(), send=f.document.workloads[0], back=structuredClone(send);
  Object.assign(back,{id:"return",from:send.to,to:send.from});
  f.document.workloads.push(back);
  f.document.scenarios[0].members.push(back.id);
  const modes=f.models.get("usb-endpoint@1").ports[0].interfaces[0].params.modes;
  oracle(f,[[modes,"Gen 1x1"],[back.request.throughput,10]]);
});
