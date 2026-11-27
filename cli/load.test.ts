// 저장 파일을 다시 열어 배선·수요·개인 주장이 판정과 출처까지 이어지는지 손계산으로 확인한다.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { evaluate } from "../engine/evaluate.ts";
import { effectiveClaim, type DomainPlugin, type Scene } from "../engine/contract.ts";
import type { Results } from "../engine/results.ts";
import { trialDomain } from "../fixtures/trial.ts";
import { connectorsFile, modelFile, sceneFile } from "./files.ts";
import { loadSceneDocuments } from "../scene/load.ts";
import { plugins as productPlugins } from "../domains/registry.ts";
import { loadScene } from "./load.ts";

function sample(t: TestContext) {
  const base = resolve("work");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "판정시험-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  function read(path: string): unknown { return JSON.parse(readFileSync(path, "utf8")); }
  const catalog = connectorsFile.parse(read("fixtures/connectors.json"));
  const saved = sceneFile.parse(read("fixtures/three-flows.json"));
  const models = ["source", "sink", "adapter"].map(id => modelFile.parse(read("fixtures/" + id + "@1.json")));
  const [host, sink, adapter] = models as [typeof models[number], typeof models[number], typeof models[number]];
  function save() {
    const write = (name: string, data: unknown) => writeFileSync(join(dir, name), JSON.stringify(data));
    write("scene.json", saved);
    write("connectors.json", catalog);
    for (const model of models) write(model.modelId + "@" + model.revision + ".json", model);
  }
  function open(plugins: DomainPlugin[] = [trialDomain()]) {
    const scene = loadScene(join(dir, "scene.json"), { modelsDir: dir, connectorsFile: join(dir, "connectors.json") }, plugins);
    return { scene, result: evaluate(scene, plugins) };
  }
  save();
  return { dir, saved, catalog, models, host, sink, adapter, save, open };
}

function workRows(scene: Scene, result: Results) {
  return result.outcomes.flatMap((o, outcome) => {
    if (o.subjectKind !== "workload") return [];
    const metrics = result.metrics.filter(m => m.outcome === outcome);
    const metric = (kind: typeof metrics[number]["kind"]) => metrics.find(m => m.kind === kind)!.value;
    const bindings = result.bindings.filter(b => b.workload === o.subjectRow && b.scenario === o.scenario && b.run === "together")
      .map(b => {
        if (b.resourceKind === "link") {
          const link = result.linkResources[b.resource]!;
          return [scene.connections[link.connection]!.id, link.direction, link.domain].join("/");
        }
        const r = scene.resources[b.resource]!;
        return [scene.items[r.item]!.id, r.id].join("/");
      }).sort();
    return [{ id: scene.workloads[o.subjectRow]!.id, verdict: o.verdict, solo: metric("solo"), together: metric("together"),
      drop: metric("drop"), percent: metric("dropPercent"), bindings }];
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function evidence(scene: Scene, result: Results) {
  return result.outcomes.map((o, outcome) => {
    const subject = o.subjectKind === "workload" ? scene.workloads[o.subjectRow]!.id : scene.connections[o.subjectRow]!.id;
    const reasons = result.reasons.flatMap((r, i) => r.outcome === outcome ? [{ ...r, i }] : []);
    assert.ok(reasons.length);
    const stages = reasons.map(r => r.stage);
    if (o.subjectKind === "workload" && o.verdict !== "impossible") {
      assert.ok(stages.includes("judge"));
      assert.ok(stages.includes("path"));
    }
    const sources = reasons.flatMap(r => {
      const inputs = result.reasonInputs.filter(x => x.reason === r.i);
      if (!inputs.length) assert.ok(result.reasonParents.some(p => p.reason === r.i && p.prior < r.i));
      return inputs.flatMap(x => {
        const c = scene.claims[x.claim]!;
        const links = scene.claimSources.filter(s => s.claim === x.claim);
        assert.ok(links.length);
        return links.map(s => [r.stage, r.rule, c.field, c.value, scene.sources[s.source]!.locator].join("/"));
      });
    });
    assert.ok(sources.length);
    return [o.subjectKind, subject, o.direction, o.verdict, ...sources.sort()].join("|");
  }).sort();
}

test("배분: 공유 자원 900을 세 작업이 나누면 작은 수요를 채운 뒤 두 작업이 400씩 쓴다", t => {
  const { scene, result } = sample(t).open();
  assert.deepEqual(workRows(scene, result), [
    { id: "a", verdict: "ok", solo: 100, together: 100, drop: 0, percent: 0, bindings: [] },
    ...["b", "c"].map(id => ({ id, verdict: "conditional", solo: 800, together: 400, drop: 400, percent: 50, bindings: ["host/trunk"] })),
  ]);
  evidence(scene, result);
  const row = result.outcomes.findIndex(o => o.subjectKind === "workload" && scene.workloads[o.subjectRow]!.id === "b");
  const parents = result.reasons.flatMap((r, i) => r.outcome === row && r.stage === "judge" ? [i] : []);
  const ancestors = new Set(parents);
  for (const r of ancestors) for (const p of result.reasonParents.filter(x => x.reason === r)) ancestors.add(p.prior);
  const inputs = result.reasonInputs.filter(i => ancestors.has(i.reason)).map(i => scene.claims[i.claim]!);
  assert.ok(inputs.some(c => c.field === "capacity" && c.value === 900));
  assert.ok(inputs.some(c => c.ownerKind === "workload" && scene.workloads[c.owner]!.id === "a" && c.value === 100));
  for (const stage of ["physical", "negotiate", "path", "allocate", "judge"])
    assert.ok([...ancestors].some(i => result.reasons[i]!.stage === stage));
});

test("배분: 실물이 서로 다른 세 자원은 지역 ID가 같아도 경쟁하지 않는다", t => {
  const f = sample(t);
  for (const id of ["b", "c"]) {
    const instanceId = "host-" + id;
    f.saved.items.push({ ...f.saved.items[0]!, instanceId });
    f.saved.connections.find(c => c.from.id === id)!.from.instanceId = instanceId;
    f.saved.workloads.find(w => w.id === id)!.from.instanceId = instanceId;
  }
  f.save();
  const { scene, result } = f.open();
  assert.deepEqual(workRows(scene, result).map(w => [w.verdict, w.together, w.drop]), [["ok", 100, 0], ["ok", 800, 0], ["ok", 800, 0]]);
  evidence(scene, result);
});

test("배분: 합산 자원을 두 번 지나는 작업은 450, 독립된 두 자원을 지나면 900이다", t => {
  const f = sample(t);
  f.saved.scenarios[0]!.members = ["b"];
  f.saved.workloads[1]!.request.rate!.value = 900;
  f.host.nodes.push({ id: "middle", label: "중간", kind: "junction" });
  const first = f.host.edges[0]!;
  first.to = "middle";
  f.host.edges.push({ ...structuredClone(first), id: "second", from: "middle", to: "out" });
  f.save();
  let run = f.open();
  assert.deepEqual(workRows(run.scene, run.result).map(w => [w.together, w.bindings]), [[450, ["host/trunk"]]]);
  evidence(run.scene, run.result);
  f.host.resources.push({ ...structuredClone(f.host.resources[0]!), id: "second" });
  f.host.edges[1]!.uses[0]!.resource = "second";
  f.save();
  run = f.open();
  assert.deepEqual(workRows(run.scene, run.result).map(w => [w.together, w.bindings]), [[900, ["host/second", "host/trunk"]]]);
  evidence(run.scene, run.result);
});

test("로더: 같은 모델의 개인 검증값은 그 실물·조건에서만 쓰이고 공용 주장과 출처가 남는다", t => {
  const f = sample(t);
  f.saved.sources.push({ id: "measurement", title: "개인 측정", locator: "fixture:measurement", retrievedAt: "2026-11-26" });
  const personal = { instanceId: "b", ownerKind: "resource" as const, ownerId: "medium", domain: "trial", field: "capacity",
    claim: { value: 200, confidence: "user_verified" as const, condition: "", unit: "회/s", sources: ["measurement"] } };
  f.saved.personal.push(personal, { ...personal, claim: { ...personal.claim, condition: "가열", value: 70 } });
  f.save();
  const { scene, result } = f.open();
  const capacities = scene.resources.flatMap((r, row) => r.id !== "medium" ? [] : [[scene.items[r.item]!.id,
    scene.claims[effectiveClaim(scene, "resource", row, r.domain, "capacity")!]!.value]]);
  assert.deepEqual(capacities, [["a", 1000], ["b", 200], ["c", 1000]]);
  const b = scene.resources.findIndex(r => scene.items[r.item]!.id === "b");
  assert.deepEqual(scene.claims.filter(c => c.ownerKind === "resource" && c.owner === b && c.field === "capacity").map(c => c.value), [1000, 200, 70]);
  assert.equal(scene.claims[effectiveClaim(scene, "resource", b, "trial", "capacity", "가열")!]!.value, 70);
  assert.equal(scene.claims[effectiveClaim(scene, "resource", b, "trial", "capacity", "대기")!]!.value, 200);
  assert.deepEqual(workRows(scene, result).map(w => w.together), [100, 200, 600]);
  assert.ok(evidence(scene, result).some(s => s.includes("fixture:measurement")));
});

test("로더: 파일 행·포트·플러그인 순서와 새 모델 판본이 달라져도 고정한 판정과 근거가 같다", t => {
  const f = sample(t), plugins = [trialDomain(), trialDomain("unused-domain")];
  const original = f.open(plugins);
  const revision = structuredClone(f.host);
  revision.revision = "2";
  revision.resources[0]!.capacity.value = 25;
  f.models.push(revision);
  f.saved.items.reverse(); f.saved.workloads.reverse(); f.saved.connections.reverse(); f.saved.scenarios[0]!.members.reverse();
  f.host.ports.reverse(); f.host.nodes.reverse(); f.sink.nodes.reverse(); f.catalog.connectors.reverse();
  f.save();
  const other = f.open(plugins.reverse());
  assert.deepEqual(workRows(other.scene, other.result), workRows(original.scene, original.result));
  assert.deepEqual(evidence(other.scene, other.result), evidence(original.scene, original.result));
  rmSync(join(f.dir, "source@1.json"));
  assert.throws(() => f.open(), /scene\.json#items\.\d+\.revision.*source@1\.json/);
});

test("T10 영역 ID와 요청·포트 키를 바꿔도 플러그인 목록만으로 같은 손계산과 근거를 낸다", t => {
  const f = sample(t);
  const original = f.open();
  for (const m of f.models) {
    for (const r of m.resources) r.domain = "other";
    for (const p of m.ports) for (const i of p.interfaces) {
      i.domain = "other"; i.params.speed = i.params.rate!; delete i.params.rate;
    }
  }
  for (const w of f.saved.workloads) { w.domain = "other"; w.request.speed = w.request.rate!; delete w.request.rate; }
  f.save();
  const renamed = f.open([trialDomain("other", "speed")]);
  assert.deepEqual(workRows(renamed.scene, renamed.result), workRows(original.scene, original.result));
  assert.deepEqual(evidence(renamed.scene, renamed.result).map(s => s.replaceAll("/speed/", "/rate/")), evidence(original.scene, original.result));
});

test("물리: 물리 불일치는 실패한 연결·양쪽 포트와 필요한 결합 형태를 남긴다", t => {
  const f = sample(t);
  f.sink.ports[0]!.connector.value = "trial-plug";
  f.save();
  const { scene, result } = f.open();
  assert.ok(workRows(scene, result).every(w => w.verdict === "impossible"));
  const outcome = result.outcomes.findIndex(o => o.subjectKind === "workload");
  const reasons = result.reasons.filter(r => r.outcome === outcome && r.stage === "physical");
  const connection = scene.connections[reasons.find(r => r.targetKind === "connection")!.targetRow]!;
  assert.deepEqual(new Set(reasons.filter(r => r.targetKind === "port").map(r => r.targetRow)), new Set([connection.from, connection.to]));
  assert.ok(result.needs.some(n => n.outcome === outcome && n.requiredCapability === "trial-socket"));
  evidence(scene, result);
});

test("물리: 부품의 커넥터가 맞아도 내부 엣지의 역방향으로는 변환할 수 없다", t => {
  const f = sample(t);
  f.saved.items.push({ instanceId: "part", modelId: "adapter", revision: "1", alias: "", state: "" });
  f.saved.connections[0]!.parts.push({ instanceId: "part", entry: "entry", exit: "exit" });
  f.save();
  const before = f.open();
  assert.equal(workRows(before.scene, before.result)[0]!.verdict, "ok");
  const e = f.adapter.edges[0]!;
  [e.from, e.to] = [e.to, e.from];
  f.save();
  const { scene, result } = f.open();
  assert.equal(workRows(scene, result)[0]!.verdict, "impossible");
  assert.ok(result.physical.some(p => p.kind === "part" && p.direction === "forward" && p.verdict === "impossible"));
  assert.ok(result.needs.some(n => n.requiredCapability.includes("entry → exit")));
  evidence(scene, result);
});

test("로더: 파일 경계에서 영역·참조·단위 오류가 파일과 필드를 가리킨다", t => {
  const f = sample(t);
  assert.throws(() => f.open([]), /source@1\.json#ports\.0\.interfaces\.0\.domain/);
  assert.throws(() => f.open([trialDomain(), trialDomain()]), /scene\.json#plugins/);
  f.saved.workloads[0]!.request.rate!.unit = "W";
  f.save();
  assert.throws(() => f.open(), /scene\.json#workloads\.0\.request\.rate\.unit/);
  f.saved.workloads[0]!.request.rate!.unit = "회/s";
  f.saved.items.push(f.saved.items[0]!);
  f.save();
  assert.throws(() => f.open(), /scene\.json#items\.4\.instanceId/);
  f.saved.items.pop();
  f.saved.connections[0]!.to.id = "missing";
  f.save();
  assert.throws(() => f.open(), /scene\.json#connections\.0\.to\.id/);
});

test("판정: 배선·용량의 null은 미확인이고 알려진 용량 0은 확정된 한도다", t => {
  const f = sample(t);
  const capacity = f.host.resources[0]!.capacity;
  capacity.value = null;
  f.save();
  let run = f.open();
  assert.ok(workRows(run.scene, run.result).every(w => w.verdict === "unknown" && w.together === null));
  capacity.value = 0;
  f.save();
  run = f.open();
  assert.ok(workRows(run.scene, run.result).every(w => w.verdict === "impossible" && w.together === 0 && w.percent === null));
  capacity.value = 900;
  f.sink.ports[0]!.attachment.value = null;
  f.save();
  run = f.open();
  assert.deepEqual(workRows(run.scene, run.result).map(w => [w.verdict, w.together]), [["ok", 100], ["conditional", 400], ["conditional", 400]]);
  evidence(run.scene, run.result);
});

test("물리: 물리 결론이 읽은 양 끝의 커넥터 값과 가능한 결합 형태를 출처로 되짚는다", t => {
  const f = sample(t);
  const { scene, result } = f.open();
  const outcome = result.outcomes.findIndex(o => o.subjectKind === "connection" && o.direction === "forward");
  const reasons = new Set(result.reasons.flatMap((r, i) => r.outcome === outcome && r.stage === "physical" ? [i] : []));
  const claims = result.reasonInputs.filter(r => reasons.has(r.reason)).map(r => scene.claims[r.claim]!);
  assert.deepEqual(claims.filter(c => c.field === "connector").map(c => c.value).sort(), ["trial-plug", "trial-socket"]);
  assert.deepEqual(claims.filter(c => c.field === "endForm").map(c => c.value).sort(), ["plug", "receptacle"]);
  evidence(scene, result);
});

test("배분: 고정 예약 뒤 연속 수요를 나누고 동시에 못 들어가는 예약에는 순서로 승자를 정하지 않는다", t => {
  const f = sample(t);
  const plugin = trialDomain();
  const consume = plugin.consume;
  let fixedAmount = 300;
  plugin.consume = (scene, w, steps, demand, options) => consume(scene, w, steps, demand, options).map(u =>
    scene.resources[u.resource]!.id === "trunk" && scene.workloads[w]!.id !== "c"
      ? { ...u, fixed: fixedAmount, coefficient: 0 } : u);
  let run = f.open([plugin]);
  assert.deepEqual(workRows(run.scene, run.result).map(w => w.together), [100, 800, 300]);
  evidence(run.scene, run.result);
  fixedAmount = 600;
  run = f.open([plugin]);
  assert.ok(workRows(run.scene, run.result).every(w => w.verdict === "unknown" && w.together === null));
  evidence(run.scene, run.result);
});

test("로더: 공용 파일에 섞인 개인 검증값이 다른 실물로 번지기 전에 위치와 함께 거절한다", t => {
  const f = sample(t);
  f.sink.resources[0]!.capacity.confidence = "user_verified";
  f.save();
  assert.throws(() => f.open(), /sink@1\.json#resources\.0\.capacity\.confidence/);
});

test("경로: 용량이 다른 평행 엣지는 이름을 교환해도 단독 성능이 큰 후보를 쓴다", t => {
  const f = sample(t);
  f.saved.scenarios[0]!.members = ["a"];
  f.host.resources[0]!.capacity.value = 0;
  const first = f.host.edges[0]!;
  first.id = "a";
  f.host.edges.push({ ...first, id: "z", uses: [] });
  for (let i = 0; i < 2; i++) {
    f.save();
    const { scene, result } = f.open();
    assert.equal(workRows(scene, result)[0]!.solo, 100);
    assert.equal(result.paths.filter(p => p.workload === 0).length, 2);
    [first.id, f.host.edges[1]!.id] = [f.host.edges[1]!.id, first.id];
  }
});

test("배분: 처리량이 0인 작업의 고정 예약을 풀어 경쟁 작업이 전량을 쓴다", t => {
  const f = sample(t);
  f.saved.scenarios[0]!.members = ["a", "b"];
  f.saved.workloads[1]!.request.rate!.value = 900;
  f.saved.personal.push({ instanceId: "a", ownerKind: "resource", ownerId: "medium", domain: "trial", field: "capacity",
    claim: { ...f.sink.resources[0]!.capacity, value: 0, confidence: "user_verified", sources: ["scene"] } });
  f.save();
  const plugin = trialDomain(), consume = plugin.consume;
  plugin.consume = (...args) => consume(...args).map(u => args[0].workloads[args[1]]!.id === "a" && args[0].resources[u.resource]!.id === "trunk"
    ? { ...u, fixed: 800, coefficient: 0 } : u);
  const { scene, result } = f.open([plugin]);
  assert.deepEqual(workRows(scene, result).map(w => [w.verdict, w.together]), [["impossible", 0], ["ok", 900]]);
});

test("모드: 고정 수요가 안 들어가면 허용한 폴백의 수요와 조건부 판정을 쓴다", t => {
  const f = sample(t), plugin = trialDomain();
  const demand = plugin.demand, negotiate = plugin.negotiate;
  plugin.demand = (...args) => [0, 1].map(preference => ({ ...demand(...args)[0]!, preference, elastic: false,
    requested: preference ? 40 : 1300, mode: preference ? "small" : "pulse" }));
  plugin.negotiate = link => ["pulse", "small"].map(mode => ({ ...negotiate(link)[0]!, mode }));
  const { scene, result } = f.open([plugin]);
  assert.ok(result.paths.filter(p => result.demands[p.demand]!.preference === 0).every(p => p.verdict === "impossible"));
  assert.ok(result.outcomes.filter(o => o.subjectKind === "workload").every(o => o.mode === "small" && o.verdict === "conditional"));
  assert.deepEqual(workRows(scene, result).map(w => w.solo), [40, 40, 40]);
});

test("모드: 한 작업은 다단 경로의 모든 연결에서 같은 모드를 협상한다", t => {
  const f = sample(t), plugin = trialDomain(), base = plugin.demand;
  f.saved.workloads[0]!.from = { instanceId: "a", id: "entry" };
  f.saved.workloads[0]!.to = { instanceId: "b", id: "end" };
  f.saved.scenarios[0]!.members = ["a"];
  f.save();
  plugin.demand = (...args) => ["pulse", "small"].map((mode, preference) => ({ ...base(...args)[0]!, mode, preference, elastic: false }));
  const negotiate = plugin.negotiate;
  plugin.negotiate = link => negotiate(link).map(o => ({ ...o, mode: link.connection === 0 ? "pulse" : "small" }));
  const { scene, result } = f.open([plugin]);
  assert.equal(workRows(scene, result)[0]!.verdict, "impossible");
});

test("로더: 같은 포트의 영역·프로토콜·역할이 겹치면 두 번째 인터페이스 위치를 알린다", t => {
  const f = sample(t), entries = f.host.ports[0]!.interfaces;
  entries.push({ ...entries[0]!, id: "different" });
  f.save();
  assert.throws(() => f.open(), /source@1\.json#ports\.0\.interfaces\.1/);
});

test("협상: 거절한 프로토콜의 선언과 규격 출처를 실패 근거에서 찾는다", t => {
  const f = sample(t);
  f.sink.ports[0]!.interfaces[0]!.protocol = "other";
  f.save();
  const { scene, result } = f.open();
  const row = result.outcomes.findIndex(o => o.subjectKind === "connection" && o.direction === "forward" && o.verdict === "impossible");
  const reason = result.reasons.findIndex(r => r.outcome === row && r.stage === "negotiate");
  const sink = scene.interfaces.find(i => i.protocol === "other")!;
  assert.ok(result.reasonInputs.some(i => i.reason === reason && i.claim === sink.evidence));
  assert.ok(result.reasonSpecs.filter(i => i.reason === reason).some(i => result.specSources[i.source]!.locator === "fixture:pulse-spec"));
});

test("협상: 무응답 영역은 옵션을 만들지 않고 미확인 한도는 연결과 작업에서 같은 판정을 낸다", t => {
  const f = sample(t), plugin = trialDomain(), negotiate = plugin.negotiate;
  plugin.negotiate = () => [];
  const silent = f.open([plugin]);
  assert.equal(silent.result.options.length, 0);
  assert.ok(silent.result.outcomes.every(o => o.verdict === "unknown"));
  plugin.negotiate = link => negotiate(link).map(o => ({ ...o, limit: null }));
  let run = f.open([plugin]);
  assert.ok(run.result.outcomes.every(o => o.verdict === "unknown"));
  plugin.negotiate = link => negotiate(link).map(o => ({ ...o, verdict: "unknown", mode: "wrong", unit: "W", limit: null }));
  run = f.open([plugin]);
  assert.ok(workRows(run.scene, run.result).every(o => o.verdict === "impossible"));
});

test("판정: 같은 장면 표에 추가한 개인 구조 주장은 무조건 문맥에서만 적용한다", t => {
  const { scene } = sample(t).open(), plugin = trialDomain();
  const row = scene.resources.findIndex(r => r.id === "trunk");
  const claim = scene.claims[effectiveClaim(scene, "resource", row, "trial", "capacity")!]!;
  const add = (value: number, condition: string) => {
    const index = scene.claims.push({ ...claim, value, condition, scope: "personal", confidence: "user_verified" }) - 1;
    scene.claimSources.push({ claim: index, source: 0 });
  };
  add(0, "가열");
  assert.equal(workRows(scene, evaluate(scene, [plugin]))[0]!.solo, 100);
  add(30, "");
  assert.equal(workRows(scene, evaluate(scene, [plugin]))[0]!.solo, 30);
});

test("배분: 소비 0인 행은 이웃의 미확인을 전파하지 않는다", t => {
  const f = sample(t), plugin = trialDomain(), consume = plugin.consume;
  f.saved.scenarios[0]!.members = ["a", "b"];
  f.saved.workloads[0]!.request.rate!.value = null;
  f.save();
  plugin.consume = (...args) => consume(...args).map(u => args[0].resources[u.resource]!.id === "trunk" && args[0].workloads[args[1]]!.id === "b" ?
    { ...u, coefficient: 0 } : u);
  const { scene, result } = f.open([plugin]);
  assert.equal(workRows(scene, result)[1]!.together, 800);
});

test("배분: 소수 계수로 동시에 포화된 두 자원이 모두 병목이다", t => {
  const f = sample(t), plugin = trialDomain(), consume = plugin.consume;
  f.saved.scenarios[0]!.members = ["a"];
  f.host.resources[0]!.capacity.value = 0.3;
  f.sink.resources[0]!.capacity.value = 0.1;
  f.save();
  plugin.consume = (...args) => consume(...args).map(u => ({ ...u, coefficient: args[0].resources[u.resource]!.id === "trunk" ? 3 : 1 }));
  const { scene, result } = f.open([plugin]);
  assert.deepEqual(workRows(scene, result)[0]!.bindings, ["a/medium", "host/trunk"]);
});

test("로더: 개인 인터페이스 단위 오류는 입력에 있는 claim.unit을 가리킨다", t => {
  const f = sample(t);
  f.saved.personal.push({ instanceId: "a", ownerKind: "interface", ownerId: "in-iface", domain: "trial", field: "rate",
    claim: { value: 100, unit: "W", condition: "", confidence: "user_verified", sources: ["scene"] } });
  f.save();
  assert.throws(() => f.open(), /scene\.json#personal\.0\.claim\.unit —/);
  Object.assign(f.saved.personal[0]!, { ownerKind: "port", ownerId: "in", domain: "", field: "attachment" });
  f.saved.personal[0]!.claim.value = "entry";
  f.save();
  assert.throws(() => f.open(), /scene\.json#personal\.0\.claim\.unit —/);
});

test("배분: 같은 방향의 링크 한도를 고정 예약과 연속 작업이 공유하고 반대 방향은 독립이다", t => {
  const f = sample(t), plugin = trialDomain(), base = plugin.demand;
  for (const w of f.saved.workloads) {
    w.from = { instanceId: "host", id: "out" }; w.to = { instanceId: "a", id: "entry" };
    w.request.rate!.value = w.id === "a" ? 80 : 100;
  }
  const reverse = f.saved.workloads[2]!;
  [reverse.from, reverse.to] = [reverse.to, reverse.from];
  f.host.ports[0]!.interfaces[0]!.params.rate!.value = 100;
  f.save();
  plugin.demand = (scene, row) => base(scene, row).map(d => ({ ...d, elastic: scene.workloads[row]!.id !== "a" }));
  const { scene, result } = f.open([plugin]);
  assert.deepEqual(result.allocations.filter(a => a.run === "together").map(a => a.value), [80, 20, 100]);
  const binding = result.bindings.find(b => b.workload === 1 && b.run === "together")!;
  assert.equal(binding.resourceKind, "link");
  const link = result.linkResources[binding.resource]!;
  assert.equal(scene.connections[link.connection]!.id, "wire-a");
  assert.equal(link.direction, "forward");
  assert.equal(link.domain, "trial");
  assert.ok(result.options.some(o => o.linkResource === binding.resource && o.limit === 100 && o.unit === "회/s"));
});

test("배분: 단독으로 성립한 작업도 동시 처리량이 0이면 예약을 다시 배분한다", t => {
  const f = sample(t), plugin = trialDomain(), consume = plugin.consume;
  f.saved.workloads[1]!.request.rate!.value = 900;
  f.save();
  plugin.consume = (...args) => {
    const [scene, work] = args;
    const uses = consume(...args), trunk = uses.find(u => scene.resources[u.resource]!.id === "trunk")!;
    switch (scene.workloads[work]!.id) {
      case "a": return uses.map(u => u === trunk ? { ...u, coefficient: 0, fixed: 800 } : u);
      case "c": return [{ ...trunk, resource: scene.resources.findIndex(r => scene.items[r.item]!.id === "a"),
        coefficient: 0, fixed: 1000 }];
      default: return uses;
    }
  };
  const { scene, result } = f.open([plugin]);
  assert.deepEqual(workRows(scene, result).map(w => [w.solo, w.together]), [[100, 0], [900, 900], [800, 800]]);
});

test("배분: 링크의 실효 한도 0은 단독·동시 성능 0의 병목으로 남는다", t => {
  const f = sample(t);
  f.host.ports[0]!.interfaces[0]!.params.rate!.value = 0;
  f.save();
  const { scene, result } = f.open();
  const row = workRows(scene, result)[0]!;
  assert.deepEqual([row.verdict, row.together, row.bindings], ["impossible", 0, ["wire-a/forward/trial"]]);
});

test("협상: 조건 없는 옵션을 연결과 워크로드가 함께 고른다", t => {
  const f = sample(t), plugin = trialDomain(), negotiate = plugin.negotiate;
  plugin.negotiate = link => negotiate(link).flatMap(o => [{ ...o, condition: "추가 조건", limit: 2000 }, o]);
  const { result } = f.open([plugin]);
  assert.ok(result.outcomes.filter(o => o.subjectKind === "connection").every(o => o.verdict === "ok"));
  assert.ok(result.reasons.filter(r => r.stage === "negotiate").every(r => r.rule !== "추가 조건"));
  assert.ok(result.steps.filter(s => s.option !== null).every(s => result.options[s.option!]!.condition === ""));
});

test("경로: 후보 열거 상한을 넘으면 일부 후보로 성능을 확정하지 않고 이유를 남긴다", t => {
  const f = sample(t);
  f.saved.scenarios[0]!.members = ["a"];
  for (let i = 0; i < 70; i++) f.host.edges.push({ ...f.host.edges[0]!, id: "parallel-" + i });
  f.save();
  const { result } = f.open();
  const row = result.outcomes.findIndex(o => o.subjectKind === "workload");
  assert.equal(result.outcomes[row]!.verdict, "unknown");
  assert.equal(result.metrics.find(m => m.outcome === row && m.kind === "solo")!.value, null);
  assert.ok(result.reasons.some(r => r.outcome === row && r.rule === "경로 후보 열거 상한"));
});

test("배분: 연쇄 예약에서 원인부터 풀면 뒤 작업이 살아난다", t => {
  const f = sample(t), plugin = trialDomain(), consume = plugin.consume;
  for (const w of f.saved.workloads) w.request.rate!.value = 100;
  f.sink.resources[0]!.capacity.value = 100;
  plugin.consume = (...args) => {
    const [scene, row] = args, evidence = consume(...args)[0]!;
    const use = (id: string, fixed: number, coefficient: number) => ({ ...evidence,
      resource: scene.resources.findIndex(r => scene.items[r.item]!.id === id), fixed, coefficient });
    switch (scene.workloads[row]!.id) {
      case "a": return [use("b", 100, 0), use("a", 0, 1)];
      case "b": return [use("c", 100, 0), use("b", 0, 1)];
      default: return [use("a", 100, 0)];
    }
  };
  for (let order = 0; order < 2; order++) {
    f.save();
    const { scene, result } = f.open([plugin]);
    assert.deepEqual(workRows(scene, result).map(w => w.together), [0, 100, 100]);
    f.saved.workloads.reverse(); f.saved.scenarios[0]!.members.reverse();
  }
});

test("배분: 고정 수요의 계수 소비와 같은 양의 직접 예약은 같은 성능을 낸다", t => {
  const f = sample(t), plugin = trialDomain(), base = plugin.demand, consume = plugin.consume;
  f.saved.scenarios[0]!.members = ["a", "b"];
  f.saved.workloads[0]!.request.rate!.value = 80;
  f.saved.workloads[1]!.request.rate!.value = 100;
  f.host.resources[0]!.capacity.value = 100;
  f.save();
  plugin.demand = (...args) => base(...args).map(d => ({ ...d, elastic: args[0].workloads[args[1]]!.id !== "a" }));
  for (const direct of [false, true]) {
    plugin.consume = (...args) => consume(...args).map(u => direct && !args[3].elastic ? { ...u, fixed: 80, coefficient: 0 } : u);
    const { scene, result } = f.open([plugin]);
    assert.deepEqual(workRows(scene, result).map(w => w.together), [80, 20]);
  }
});

test("경로: 불가인 연결 65개가 유일하게 성립하는 경로를 가리지 않는다", t => {
  const f = sample(t), plugin = trialDomain(), base = plugin.negotiate;
  f.saved.scenarios[0]!.members = ["a"];
  const wire = f.saved.connections[0]!;
  for (let i = 0; i < 65; i++) {
    const id = "blocked-" + i;
    for (const model of [f.host, f.sink]) {
      const p = structuredClone(model.ports[0]!);
      p.id = id;
      p.interfaces[0]!.id = id;
      model.ports.push(p);
    }
    f.saved.connections.push({ ...wire, id, from: { ...wire.from, id }, to: { ...wire.to, id } });
  }
  f.save();
  plugin.negotiate = link => base(link).map(o => ({ ...o,
    verdict: link.scene.connections[link.connection]!.id.startsWith("blocked-") ? "impossible" : o.verdict }));
  const { scene, result } = f.open([plugin]);
  assert.deepEqual(workRows(scene, result).map(w => [w.verdict, w.solo]), [["ok", 100]]);
});

test("배분: 수요 0의 미확인 링크는 함께 쓰는 내부 자원으로 전파되지 않는다", t => {
  const f = sample(t);
  f.saved.workloads[0]!.request.rate!.value = 0;
  f.host.ports[0]!.interfaces[0]!.params.rate!.value = null;
  f.saved.scenarios[0]!.members = ["a", "b"];
  f.save();
  const { scene, result } = f.open();
  const b = workRows(scene, result).find(w => w.id === "b")!;
  assert.deepEqual([b.verdict, b.together], ["ok", 800]);
});

test("협상: 다른 영역만 선언한 수신 포트의 거절에는 그 선언 근거가 있다", t => {
  const f = sample(t);
  f.sink.ports[0]!.interfaces[0]!.domain = "other";
  f.save();
  const silent = trialDomain(), other = trialDomain("other");
  silent.negotiate = () => [];
  other.negotiate = () => [];
  for (const sender of [silent, trialDomain()]) {
    const { scene, result } = f.open([sender, other]);
    const sink = scene.interfaces.find(i => i.domain === "other")!;
    const work = result.outcomes.findIndex(o => o.subjectKind === "workload" && o.subjectRow === 0);
    const wire = result.outcomes.findIndex(o => o.subjectKind === "connection" && o.subjectRow === 0 && o.direction === "forward" && o.domain === "trial");
    for (const outcome of [work, wire]) {
      assert.equal(result.outcomes[outcome]?.verdict, "impossible");
      assert.ok(result.reasonInputs.some(i => i.claim === sink.evidence && result.reasons[i.reason]!.outcome === outcome));
    }
  }
});

test("판정: 폴백 근거에서 거절된 고정 요청과 링크 한도를 함께 찾는다", t => {
  const f = sample(t), plugin = trialDomain(), base = plugin.demand, negotiate = plugin.negotiate;
  f.saved.scenarios[0]!.members = ["a"];
  f.host.ports[0]!.interfaces[0]!.params.rate!.value = 60;
  f.save();
  plugin.demand = (...args) => [0, 1].map(preference => ({ ...base(...args)[0]!, preference, elastic: false,
    requested: preference ? 40 : 100, mode: preference ? "small" : "pulse", rule: preference ? "축소 요청" : "원래 요청" }));
  plugin.negotiate = link => negotiate(link).flatMap(o => [o, { ...o, mode: "small", inputs: [], rule: "축소 모드 규칙" }]);
  const { scene, result } = f.open([plugin]);
  const outcome = result.outcomes.findIndex(o => o.subjectKind === "workload");
  assert.equal(result.outcomes[outcome]!.mode, "small");
  const original = result.reasons.findIndex(r => r.outcome === outcome && r.rule.includes("원래 요청"));
  assert.ok(original >= 0);
  const ancestors = new Set([original]);
  for (const r of ancestors) for (const p of result.reasonParents) if (p.reason === r) ancestors.add(p.prior);
  const values = result.reasonInputs.filter(i => ancestors.has(i.reason)).map(i => scene.claims[i.claim]!.value);
  assert.ok(values.includes(100) && values.includes(60));
});

test("계약: 같은 미등록 규격도 어느 진입점의 어느 행에서 나왔는지 구별한다", t => {
  const f = sample(t), plugin = trialDomain();
  const missing = {rule:"잘못된 인용", inputs:[], specs:["missing-spec"]};
  const {negotiate,demand,consume} = plugin;
  plugin.negotiate = link => negotiate(link).map(o => ({...o,...missing}));
  plugin.pools = () => [{...missing,id:"shared",scope:"direction",limit:100,unit:"회/s"}];
  plugin.demand = (s,w) => demand(s,w).map(d => ({...d,...missing}));
  plugin.match = () => ({...missing,verdict:"ok"});
  plugin.consume = (...args) => consume(...args).map(u => ({...u,...missing}));
  plugin.assess = () => ({...missing,possible:["ok"],metrics:[]});
  f.host.resources[0]!.policy.value = "port-table";
  plugin.policy = ({activeWorkloads}) => activeWorkloads.map(workload => ({...missing,workload,limit:100}));
  f.save();
  const {scene,result} = f.open([plugin]);
  assert.ok(result.reasonSpecs.every(r => !!result.specSources[r.source]));
  for (const [entryPoint,targetKind] of [
    ["negotiate","linkResource"],["pools","linkResource"],["demand","workload"],["match","workload"],
    ["assess","workload"],["consume","path"],["policy","path"],
  ] as const) {
    const table = targetKind === "linkResource" ? result.linkResources : targetKind === "workload" ? scene.workloads : result.paths;
    const faults = result.errors.filter(e => e.entryPoint === entryPoint);
    assert.ok(faults.length,entryPoint);
    assert.ok(faults.every(e => e.domain === plugin.id && e.spec === "missing-spec" && e.targetKind === targetKind && table[e.row]));
  }
});

test("협상: 한도 0인 연결은 연결 자체에서도 불가다", t => {
  const f = sample(t);
  f.host.ports[0]!.interfaces[0]!.params.rate!.value = 0;
  f.save();
  const { result } = f.open();
  assert.equal(result.outcomes.find(o => o.subjectKind === "connection" && o.subjectRow === 0)!.verdict, "impossible");
});

test("경로: 호스트 경유 복사는 같은 허브 업링크를 두 번 소비한다", t => {
  const f = sample(t), plugin = trialDomain(), base = plugin.demand;
  f.saved.scenarios[0]!.members = ["a"];
  const w = f.saved.workloads[0]!;
  w.from = { instanceId: "a", id: "entry" }; w.to = { instanceId: "b", id: "entry" }; w.request.rate!.value = 900;
  f.host.edges.push({ ...f.host.edges[0]!, from: "out", to: "root", id: "return" });
  f.save();
  plugin.demand = (...args) => base(...args).map(d => ({ ...d, via: [args[0].nodes.findIndex(n => n.id === "root")] }));
  const { scene, result } = f.open([plugin]);
  assert.deepEqual(workRows(scene, result).map(w => [w.solo, w.together, w.bindings]), [[450, 450, ["host/trunk"]]]);
  const path = result.outcomes.find(o => o.subjectKind === "workload")!.path;
  assert.deepEqual(result.steps.filter(s => s.path === path && s.kind === "edge").map(s => scene.edges[s.row]!.id), ["return", "root-out"]);
});

test("배분: 다른 자원에서 막힌 예약을 회수한 뒤 남은 예약 초과를 판정한다", t => {
  const f = sample(t), plugin = trialDomain(), consume = plugin.consume;
  f.sink.resources[0]!.capacity.value = 100;
  for (const w of f.saved.workloads) w.request.rate!.value = 100;
  plugin.consume = (...args) => {
    const [scene, row] = args, evidence = consume(...args)[0]!;
    const use = (id: string, fixed: number, coefficient: number) => ({ ...evidence,
      resource: scene.resources.findIndex(r => scene.items[r.item]!.id === id), fixed, coefficient });
    switch (scene.workloads[row]!.id) {
      case "a": return [use("a", 100, 0), use("b", 0, 1)];
      case "b": return [use("a", 100, 0)];
      default: return [use("b", 100, 0)];
    }
  };
  for (let order = 0; order < 2; order++) {
    f.save();
    const { scene, result } = f.open([plugin]);
    assert.deepEqual(workRows(scene, result).map(w => [w.verdict, w.together]), [["impossible", 0], ["ok", 100], ["ok", 100]]);
    f.saved.workloads.reverse(); f.saved.scenarios[0]!.members.reverse();
  }
  f.saved.scenarios[0]!.members = ["a", "b"];
  f.save();
  const { scene, result } = f.open([plugin]);
  assert.deepEqual(workRows(scene, result).map(w => [w.verdict, w.together]), [["unknown", null], ["unknown", null]]);
});

test("판정: 단독 배분에서 탈락한 원래 모드의 요청과 장면 자원 출처가 폴백에 이어진다", t => {
  const f = sample(t), plugin = trialDomain(), demand = plugin.demand, negotiate = plugin.negotiate, consume = plugin.consume;
  f.host.resources[0]!.capacity.value = 60;
  f.saved.scenarios[0]!.members = ["a"];
  f.save();
  plugin.demand = (...args) => [0, 1].map(preference => ({ ...demand(...args)[0]!, preference, elastic: false,
    requested: preference ? 40 : 100, mode: preference ? "small" : "pulse", rule: preference ? "축소 요청" : "원래 요청" }));
  plugin.negotiate = link => negotiate(link).flatMap(o => [o, { ...o, mode: "small" }]);
  plugin.consume = (...args) => args[3].preference ? [] : consume(...args);
  const { scene, result } = f.open([plugin]);
  const outcome = result.outcomes.findIndex(o => o.subjectKind === "workload");
  assert.deepEqual([result.outcomes[outcome]!.mode, ...workRows(scene, result).map(w => [w.verdict, w.together])], ["small", ["conditional", 40]]);
  const root = result.reasons.findIndex(r => r.outcome === outcome && r.stage === "judge");
  function ancestors(row: number) {
    const rows = new Set([row]);
    for (const child of rows) for (const p of result.reasonParents) if (p.reason === child) rows.add(p.prior);
    return rows;
  }
  const refusal = [...ancestors(root)].find(i => result.reasons[i]!.targetKind === "demand" &&
    result.demands[result.reasons[i]!.targetRow]!.mode === "pulse");
  assert.notEqual(refusal, undefined);
  const proof = ancestors(refusal!);
  const claims = result.reasonInputs.filter(i => proof.has(i.reason)).map(i => i.claim);
  const work = result.outcomes[outcome]!.subjectRow, trunk = scene.resources.findIndex(r => r.id === "trunk");
  const expected = [effectiveClaim(scene, "workload", work, "trial", "rate")!, effectiveClaim(scene, "resource", trunk, "trial", "capacity")!];
  assert.deepEqual(expected.map(c => scene.claims[c]!.value), [100, 60]);
  for (const c of expected) {
    assert.ok(claims.includes(c));
    assert.ok(scene.claimSources.some(s => s.claim === c && scene.sources[s.source]!.locator));
  }
  assert.ok([...proof].some(i => result.reasons[i]!.stage === "allocate" && result.reasons[i]!.targetKind === "resource" && result.reasons[i]!.targetRow === trunk));
});

test("협상: 커넥터가 미확인이어도 알려진 한도 0이면 연결과 작업은 불가다", t => {
  const f = sample(t);
  f.saved.scenarios[0]!.members = ["a"];
  f.host.ports[0]!.connector.value = null;
  f.host.ports[0]!.interfaces[0]!.params.rate!.value = 0;
  f.save();
  const { scene, result } = f.open();
  const link = result.outcomes.find(o => o.subjectKind === "connection" && o.direction === "forward" && scene.connections[o.subjectRow]!.id === "wire-a")!;
  assert.equal(link.verdict, "impossible");
  assert.deepEqual(workRows(scene, result).map(w => [w.verdict, w.solo, w.together, w.bindings]), [["impossible", 0, 0, ["wire-a/forward/trial"]]]);
});

test("T3 연결 끝과 부품에서 같은 포트를 다시 점유하면 두 위치를 알려 준다", t => {
  const f = sample(t);
  const second = f.saved.connections[1]!;
  second.from = { ...f.saved.connections[0]!.from };
  f.save();
  assert.throws(() => f.open(), (e: Error) => e.message.includes("#connections.0.from") && e.message.includes("#connections.1.from"));
  f.saved.items.push({ ...f.saved.items[0]!, instanceId: "part", modelId: "adapter" });
  f.saved.connections[0]!.parts.push({ instanceId: "part", entry: "entry", exit: "exit" });
  for (const side of ["entry", "exit"]) {
    second.from = { instanceId: "part", id: side };
    f.save();
    assert.throws(() => f.open(), (e: Error) => e.message.includes("#connections.0.parts.0." + side) && e.message.includes("#connections.1.from"));
  }
});

test("T10 프로토콜별 스키마는 기본 매개변수와 개인 주장 양쪽에 적용된다", t => {
  const f = sample(t), trial = trialDomain();
  const schema = { safeParse(fields: unknown) {
    const v = (fields as { rate?: { value: number | null }; lanes?: unknown });
    return v.lanes !== undefined && v.rate?.value !== 999 ? { success: true as const } :
      { success: false as const, error: { issues: [{ path: v.lanes === undefined ? ["lanes"] : ["rate","value"], message: "시험 프로토콜 위반" }] } };
  } };
  const plugin = { ...trial, paramsFor: (p: string) => p === "special" ? schema : undefined };
  const iface = f.host.ports[0]!.interfaces[0]!;
  iface.protocol = "special";
  f.save();
  assert.throws(() => f.open([plugin]), /source@1.json#ports.0.interfaces.0.params.lanes/);
  iface.params.lanes = { ...iface.params.rate!, value: null };
  f.save();
  assert.doesNotThrow(() => f.open([plugin]));
  f.saved.personal.push({ instanceId: "host", ownerKind: "interface", ownerId: iface.id, domain: "trial", field: "rate",
    claim: { ...iface.params.rate!, value: 999, confidence: "user_verified", sources: ["scene"] } });
  f.save();
  assert.throws(() => f.open([plugin]), /scene.json#personal.0.claim.value/);
});

test("T4 시나리오의 우선순위가 입력 주장과 출처를 통해 고정 예약 근거에 남는다", t => {
  const f = sample(t);
  f.saved.scenarios[0]!.members = ["a","b"].map((workload,priority) => ({ workload, priority: { value: priority, unit: "",
    confidence: "inferred" as const, sources: ["scene"], condition: "" } }));
  f.save();
  const trial = trialDomain();
  const plugin = { ...trial, demand: (...args: Parameters<typeof trial.demand>) => trial.demand(...args).map(d => ({ ...d, requested: 800, elastic: false })) };
  const { scene, result } = f.open([plugin]);
  assert.deepEqual(workRows(scene,result).map(w => w.together),[800,0]);
  const claim = scene.members[0]!.evidence!;
  assert.ok(scene.claimSources.some(c => c.claim === claim && scene.sources[c.source]!.locator === "fixture:scene"));
  assert.ok(result.reasonInputs.some(c => c.claim === claim && result.reasons[c.reason]!.rule.includes("우선순위")));
});

test("T10 메모리 문서와 고정 판본 파일은 같은 장면·근거·제품 영역 판정을 낸다", () => {
  const dir = "fixtures/network", file = join(dir,"scene.json");
  const doc = (name: string): unknown => JSON.parse(readFileSync(name,"utf8"));
  const saved = sceneFile.parse(doc(file)), connectors = doc(join(dir,"connectors.json"));
  const models = new Map(saved.items.map(item => {
    const key = item.modelId + "@" + item.revision;
    return [key, doc(join(dir,key + ".json"))] as const;
  }));
  const memory = loadSceneDocuments(saved,{models,connectors},productPlugins);
  const disk = loadScene(file,{modelsDir:dir,connectorsFile:join(dir,"connectors.json")},productPlugins);
  assert.deepEqual(memory,disk);
  assert.deepEqual(evaluate(memory,productPlugins),evaluate(disk,productPlugins));
  assert.ok(memory.claimSources.length);
  assert.equal(productPlugins.some(p => p.id === "trial"),false);
});

test("T10 캔버스 배치·포트 좌표·도형은 출처와 위치를 검증하고 판정에는 영향을 주지 않는다", t => {
  const f = sample(t), base = f.open();
  const item = f.saved.items[0]!.instanceId;
  f.saved.layout = { placements: [{ instanceId:item,x:-12,y:40 }], viewport:{cx:3,cy:-2,zoom:1.5} };
  const port = f.host.ports[0]!;
  port.position = { face:"rear",x:1,y:0,confidence:"official",sources:[f.host.sources[0]!.id] };
  f.catalog.connectors[0]!.glyph = "socket-a";
  f.save();
  assert.deepEqual(f.open(),base);
  const { models, catalog:connectors, saved } = f;
  const library = { models:new Map(models.map(m => [m.modelId + "@" + m.revision,m])),connectors };
  const open = () => loadSceneDocuments(saved,library,[trialDomain()]);
  const placement = saved.layout!.placements![0]!;
  saved.layout!.placements!.push(placement);
  assert.throws(open,/scene.json#layout.placements.1.instanceId/);
  saved.layout!.placements!.pop();
  placement.instanceId = "없는 실물";
  assert.throws(open,/scene.json#layout.placements.0.instanceId/);
  placement.instanceId = item;
  saved.layout!.viewport!.zoom = 0;
  assert.throws(open,/scene.json#layout.viewport.zoom/);
  saved.layout!.viewport!.zoom = 1;
  port.position.x = 1.1;
  assert.throws(open,/source@1.json#ports.0.position.x/);
  port.position.x = 0.5;
  port.position.sources = ["없는 출처"];
  assert.throws(open,/source@1.json#ports.0.position.sources.0/);
  port.position.sources = [f.host.sources[0]!.id];
  f.host.revision = "2";
  assert.throws(open,/scene.json#items.0.revision.*source@1.json/);
});
