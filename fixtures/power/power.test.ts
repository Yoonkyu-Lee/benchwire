// 합성 배선에서 충전기의 접속 정책, 케이블과 패스스루 한도를 추론 및 출처까지 확인한다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadScene } from "../../cli/load.ts";
import { effectiveClaim, type Scene } from "../../engine/contract.ts";
import { evaluate } from "../../engine/evaluate.ts";
import { assessCharge } from "../../domains/power/charge.ts";
import { power } from "../../domains/power/power.ts";

const local = (file: string) => fileURLToPath(new URL(file, import.meta.url));
const plugins = [power];

function read(name: string) {
  return loadScene(local(name + ".json"), { modelsDir: local("."), connectorsFile: local("connectors.json") }, plugins);
}

function analyze(scene: Scene) {
  const result = evaluate(scene, plugins);
  assert.deepEqual(result.errors, []);
  function work(scenario: string, id = scenario) {
    const outcome = result.outcomes.findIndex(o => o.subjectKind === "workload" &&
      scene.scenarios[o.scenario!]!.id === scenario && scene.workloads[o.subjectRow]!.id === id);
    assert.ok(outcome >= 0);
    const metric = (kind: "solo" | "together") => {
      const m = result.metrics.find(m => m.outcome === outcome && m.kind === kind)!;
      assert.equal(m.unit, "W");
      return m;
    };
    const root = result.reasons.findLastIndex(reason => reason.outcome === outcome && reason.stage === "judge");
    assert.ok(root >= 0);
    const reasons = new Set([root]);
    for (const reason of reasons) for (const parent of result.reasonParents)
      if (parent.reason === reason) reasons.add(parent.prior);
    const claims = result.reasonInputs.filter(i => reasons.has(i.reason)).map(i => i.claim);
    const citations = scene.claimSources.filter(s => claims.includes(s.claim)).map(s => scene.sources[s.source]!.id);
    const specs = result.reasonSpecs.filter(s => reasons.has(s.reason)).map(s => result.specSources[s.source]!.id);
    return { outcome, workload: result.outcomes[outcome]!.subjectRow, verdict: result.outcomes[outcome]!.verdict,
      metric, reasons: [...reasons].map(row => result.reasons[row]!),
      claims, citations, specs };
  }
  return { result, work };
}

function cableClaim(scene: Scene, field: string) {
  return scene.interfaces.flatMap((i, row) => i.role === "cable" ? [effectiveClaim(scene, "interface", row, "power", field)!] : []);
}

test("T8 세 포트에서 50·30·20 W를 전달하고 A의 소비 상황에 따라 순충전을 판정한다", () => {
  const scene = read("three-ports");
  const { result, work } = analyze(scene);
  for (const [scenario, load, verdict, net] of [
    ["idle", 20, "ok", 30], ["normal", 45, "conditional", 5], ["max", 70, "impossible", -20],
  ] as const) {
    const a = work(scenario);
    assert.equal(a.metric("solo").value, 50);
    assert.equal(a.metric("together").value, 50);
    assert.equal(a.verdict, verdict);
    const loadClaim = effectiveClaim(scene, "workload", a.workload, "power", "loadW")!;
    const targetClaim = effectiveClaim(scene, "workload", a.workload, "power", "targetW")!;
    assert.equal(scene.claims[loadClaim]!.value, load);
    assert.equal(scene.claims[targetClaim]!.value, 30);
    for (const run of ["solo", "together"] as const) {
      assert.deepEqual(result.assessments.filter(r => r.outcome === a.outcome && r.run === run).map(r => r.verdict), [verdict]);
      assert.deepEqual(result.measures.find(m => m.outcome === a.outcome && m.run === run && m.kind === "netCharge"),
        { outcome: a.outcome, run, kind: "netCharge", unit: "W", low: net, high: net });
      const reason = result.reasons.findIndex(r => r.outcome === a.outcome && r.run === run && r.stage === "judge");
      assert.ok(reason >= 0);
      for (const claim of [loadClaim, targetClaim]) {
        assert.ok(result.reasonInputs.some(i => i.reason === reason && i.claim === claim));
        assert.ok(scene.claimSources.some(s => s.claim === claim && scene.sources[s.source]!.id === "scene"));
      }
      assert.ok(result.reasonParents.some(p => p.reason === reason && /요청과 단독·동시 성능/.test(result.reasons[p.prior]!.rule)));
    }
    assert.equal(work(scenario, "b").metric("together").value, 30);
    assert.equal(work(scenario, "c").metric("together").value, 20);
    assert.equal(work(scenario, "b").verdict, "ok");
    assert.equal(work(scenario, "c").verdict, "ok");
    assert.ok(a.reasons.some(r => r.stage === "negotiate" && /접속 포트/.test(r.rule)));
    assert.ok(a.reasons.some(r => r.stage === "allocate" && r.targetKind === "resource"));
    for (const id of ["supply", "receiver", "cable-3a", "table", "scene"]) assert.ok(a.citations.includes(id), id);
    assert.ok(a.specs.includes("pd-fixed"));
    assert.ok(a.specs.includes("type-c-cable"));
  }
  assert.equal(work("only-a", "max").metric("together").value, 50);
  assert.equal(work("same-port", "idle").metric("together").value, 25);
  assert.equal(work("same-port", "normal").metric("together").value, 25);
  const shared = work("same-port", "normal");
  assert.deepEqual(result.assessments.filter(r => r.outcome === shared.outcome).map(r => [r.run, r.verdict]),
    [["solo", "conditional"], ["together", "impossible"]]);
  assert.deepEqual(result.measures.filter(m => m.outcome === shared.outcome).map(m => [m.run, m.low, m.high]),
    [["solo", 5, 5], ["together", -20, -20]]);
});

test("T8 다른 포트를 분리하면 전자 표지가 없는 케이블이 20 V·3 A와 60 W를 제한한다", () => {
  const scene = read("single-port");
  for (const claim of cableClaim(scene, "currentA")) Object.assign(scene.claims[claim]!, { value: null, confidence: "unknown" });
  const { result, work } = analyze(scene);
  const a = work("single", "idle");
  assert.equal(a.verdict, "ok");
  assert.equal(a.metric("together").value, 60);
  assert.ok(a.reasons.some(r => r.stage === "negotiate" && /20 V · 3 A · 60 W/.test(r.rule)));
  assert.ok(a.citations.includes("cable-3a"));
  assert.ok(a.specs.includes("type-c-cable"));
  assert.ok(result.bindings.some(b => b.run === "together" && b.resourceKind === "link"));
});

test("T8 e-marker 전류가 미확인이면 전달 60–80 W, 순충전 40–60 W와 가능한 판정이 남는다", () => {
  const scene = read("single-port");
  const target = scene.claims[effectiveClaim(scene, "workload", 0, "power", "targetW")!]!;
  for (const claim of cableClaim(scene, "eMarked")) scene.claims[claim]!.value = true;
  const currents = cableClaim(scene, "currentA");
  for (const claim of currents) Object.assign(scene.claims[claim]!, { value: null, confidence: "unknown" });
  const guaranteed = analyze(scene);
  const guaranteedCharge = guaranteed.work("single", "idle");
  assert.equal(guaranteedCharge.verdict, "ok");
  assert.deepEqual(guaranteed.result.measures.find(m => m.outcome === guaranteedCharge.outcome && m.run === "together"),
    { outcome: guaranteedCharge.outcome, run: "together", kind: "netCharge", unit: "W", low: 40, high: 60 });
  target.value = 50;
  const { result, work } = analyze(scene);
  const a = work("single", "idle");
  assert.equal(a.verdict, "unknown");
  assert.equal(a.metric("together").value, null);
  assert.deepEqual([a.metric("together").low, a.metric("together").high], [60, 80]);
  for (const run of ["solo", "together"] as const) {
    assert.deepEqual(result.assessments.filter(r => r.outcome === a.outcome && r.run === run).map(r => r.verdict), ["ok", "conditional"]);
    assert.deepEqual(result.measures.find(m => m.outcome === a.outcome && m.run === run && m.kind === "netCharge"),
      { outcome: a.outcome, run, kind: "netCharge", unit: "W", low: 40, high: 60 });
  }
  assert.ok(result.quests.some(q => q.outcome === a.outcome && currents.includes(q.claim) && /전류/.test(q.instruction)));
  assert.ok(a.reasons.some(r => r.stage === "negotiate"));
  assert.ok(a.citations.includes("cable-3a"));
  assert.ok(a.specs.includes("type-c-cable"));
});

test("T8 공통 전압이 없거나 소스와 싱크가 역방향이면 전력 경로가 불가다", () => {
  const scene = read("single-port");
  const sink = scene.interfaces.findIndex(i => i.role === "sink");
  assert.ok(scene.interfaces[sink]);
  const pdo = effectiveClaim(scene, "interface", sink, "power", "accepts20")!;
  scene.claims[pdo] = { ...scene.claims[pdo]!, field: "accepts15" };
  const { result, work } = analyze(scene);
  const a = work("single", "idle");
  assert.equal(a.verdict, "impossible");
  assert.equal(a.metric("together").value, 0);
  assert.ok(a.reasons.some(r => r.stage === "negotiate" && /공통 고정 PDO/.test(r.rule)));
  assert.ok(a.claims.includes(pdo));
  assert.ok(a.citations.includes("supply") && a.citations.includes("receiver"));
  assert.ok(a.specs.includes("pd-fixed"));
  assert.equal(result.options.find(o => o.direction === "reverse")!.verdict, "impossible");
});

test("T8 여러 공통 PDO에서 포트 정격까지 고려해 가장 많은 전력을 넘길 수 있는 전압을 고른다", () => {
  const scene = read("single-port");
  const source = scene.interfaces.findIndex(i => i.role === "source");
  const sink = scene.interfaces.findIndex(i => i.role === "sink");
  const offer = scene.claims[effectiveClaim(scene, "interface", source, "power", "pdo20")!]!;
  const accept = scene.claims[effectiveClaim(scene, "interface", sink, "power", "accepts20")!]!;
  offer.value = 1;
  const maxW = effectiveClaim(scene, "interface", source, "power", "maxW")!;
  scene.claims[maxW]!.value = 30;
  const alternative = scene.claims.push({ ...offer, field: "pdo15", value: 3 }, { ...accept, field: "accepts15" }) - 2;
  scene.claimSources.push({ claim: alternative, source: scene.sources.findIndex(s => s.id === "supply") },
    { claim: alternative + 1, source: scene.sources.findIndex(s => s.id === "receiver") });
  const a = analyze(scene).work("single", "idle");
  assert.equal(a.verdict, "conditional");
  assert.equal(a.metric("together").value, 30);
  assert.ok(a.reasons.some(r => r.stage === "negotiate" && /15 V · 2 A · 30 W/.test(r.rule)));
  assert.ok(a.claims.includes(maxW) && a.claims.includes(alternative) && a.claims.includes(alternative + 1));
  assert.ok(a.specs.includes("pd-fixed"));
});

test("T8 48 V 고정 PDO는 케이블이 5 A와 EPR 전압을 전자 표지로 알릴 때 240 W를 지원한다", () => {
  const scene = read("single-port");
  scene.interfaces.forEach(({ role }, row) => {
    if (role !== "source" && role !== "sink") return;
    const maxW = effectiveClaim(scene, "interface", row, "power", "maxW")!;
    scene.claims[maxW]!.value = 240;
    const pdo = effectiveClaim(scene, "interface", row, "power", role === "source" ? "pdo20" : "accepts20")!;
    scene.claims[pdo]!.field = role === "source" ? "pdo48" : "accepts48";
  });
  scene.claims[effectiveClaim(scene, "item", 0, "power", "budget:a:a")!]!.value = 240;
  scene.claims[effectiveClaim(scene, "resource", 0, "power", "capacity")!]!.value = 240;
  scene.claims[effectiveClaim(scene, "workload", 0, "power", "requestedW")!]!.value = 240;
  for (const claim of cableClaim(scene, "currentA")) scene.claims[claim]!.value = 5;
  for (const claim of cableClaim(scene, "eMarked")) scene.claims[claim]!.value = true;
  const markings = cableClaim(scene, "eprVoltage");
  const incompatible = analyze(scene).work("single", "idle");
  assert.equal(incompatible.verdict, "impossible");
  assert.ok(markings.some(claim => incompatible.claims.includes(claim)));
  for (const claim of markings) scene.claims[claim]!.value = 50;
  const supported = analyze(scene).work("single", "idle");
  assert.equal(supported.verdict, "ok");
  assert.equal(supported.metric("together").value, 240);
  assert.ok(supported.reasons.some(r => r.stage === "negotiate" && /48 V · 5 A · 240 W/.test(r.rule)));
  assert.ok(markings.every(claim => supported.claims.includes(claim)));
  assert.ok(supported.specs.includes("pd-fixed") && supported.specs.includes("type-c-cable"));
});

test("T8 접속 조합표의 명시적인 미확인 값은 한도와 퀘스트로 이어진다", () => {
  const scene = read("single-port");
  const budget = effectiveClaim(scene, "item", 0, "power", "budget:a:a")!;
  Object.assign(scene.claims[budget]!, { value: null, confidence: "unknown" });
  const { result, work } = analyze(scene);
  const a = work("single", "idle");
  assert.equal(a.verdict, "unknown");
  assert.deepEqual([a.metric("together").low, a.metric("together").high], [0, 60]);
  assert.ok(a.citations.includes("table"));
  assert.ok(result.quests.some(q => q.outcome === a.outcome && q.claim === budget && /접속 포트/.test(q.instruction)));
});

test("T8 충전기 총예산이 포트별 한도보다 작으면 총예산이 병목에 남는다", () => {
  const scene = read("three-ports");
  const total = effectiveClaim(scene, "resource", 0, "power", "capacity")!;
  scene.claims[total]!.value = 90;
  const { result, work } = analyze(scene);
  const a = work("idle");
  assert.equal(a.metric("together").value, 40);
  assert.ok(a.claims.includes(total));
  assert.ok(result.bindings.some(b => b.scenario === 0 && b.run === "together" && b.resourceKind === "scene" && b.resource === 0));
});

test("T8 패스스루 입력의 60 W에서 중간 장치의 10 W를 한 번 빼고 두 작업은 50 W를 공유한다", () => {
  const { result, work } = analyze(read("passthrough"));
  const one = work("solo", "primary");
  assert.equal(one.metric("together").value, 50);
  assert.equal(work("shared", "primary").metric("together").value, 25);
  assert.equal(work("shared", "secondary").metric("together").value, 25);
  assert.equal(one.verdict, "ok");
  const shared = work("shared", "primary");
  assert.equal(shared.verdict, "ok");
  assert.deepEqual(result.measures.find(m => m.outcome === shared.outcome && m.run === "together"),
    { outcome: shared.outcome, run: "together", kind: "netCharge", unit: "W", low: 25, high: 25 });
  assert.ok(one.reasons.some(r => r.stage === "negotiate" && /공통 고정 PDO .*60 W/.test(r.rule)));
  assert.ok(one.reasons.some(r => r.stage === "allocate" && /자체 소비 10 W/.test(r.rule)));
  assert.ok(one.citations.includes("relay"));
  assert.ok(one.specs.includes("pd-fixed"));
});

test("T8 패스스루의 자체 소비를 소스 총예산과 실제 입력 방향에 한 번씩 반영한다", () => {
  const scene = read("passthrough");
  const total = effectiveClaim(scene, "resource", 0, "power", "capacity")!;
  const reserve = effectiveClaim(scene, "interface", scene.interfaces.findIndex(i => i.id === "in-power"), "power", "reserveW")!;
  scene.claims[total]!.value = 45;
  const input = scene.connections.find(c => c.id === "up")!;
  [input.from, input.to] = [input.to, input.from];
  for (const part of scene.parts.filter(p => p.connection === scene.connections.indexOf(input)))
    [part.entry, part.exit] = [part.exit, part.entry];

  const { result, work } = analyze(scene);
  const one = work("solo", "primary");
  assert.equal(one.metric("together").value, 35);
  assert.ok(one.claims.includes(reserve));
  assert.ok(one.citations.includes("relay"));
  for (const id of ["primary", "secondary"]) {
    const shared = work("shared", id);
    assert.equal(shared.metric("solo").value, 35);
    assert.equal(shared.metric("together").value, 17.5);
    assert.ok(shared.claims.includes(reserve));
  }
  assert.deepEqual(result.standingErrors, []);
  assert.deepEqual(result.standingLoads.map(l => [l.kind, l.amount]).sort(), [["link", 10], ["scene", 10]]);
  const link = result.standingLoads.find(l => l.kind === "link")!;
  assert.equal(result.linkResources[link.resource]!.direction, "reverse");
  scene.claims[total]!.value = 90;
  assert.equal(analyze(scene).work("solo", "primary").metric("together").value, 50);
});

test("T8 패스스루 자체 소비가 미확인이면 소스 총예산까지의 범위와 확인 퀘스트를 남긴다", () => {
  const scene = read("passthrough");
  const total = effectiveClaim(scene, "resource", 0, "power", "capacity")!;
  const reserve = effectiveClaim(scene, "interface", scene.interfaces.findIndex(i => i.id === "in-power"), "power", "reserveW")!;
  scene.claims[total]!.value = 45;
  Object.assign(scene.claims[reserve]!, { value: null, confidence: "unknown" });

  const { result, work } = analyze(scene);
  const one = work("solo", "primary");
  for (const run of ["solo", "together"] as const) {
    const { low, high } = one.metric(run);
    assert.deepEqual([low, high], [0, 45]);
  }
  assert.deepEqual(result.standingLoads.map(l => [l.kind, l.amount]).sort(), [["link", null], ["scene", null]]);
  assert.ok(one.claims.includes(reserve));
  assert.ok(one.citations.includes("relay"));
  assert.ok(result.quests.some(q => q.outcome === one.outcome && q.claim === reserve && /패스스루 입력/.test(q.instruction)));
});

test("T8 작업이 패스스루를 지나지 않아도 전력을 받는 패스스루는 다른 포트와 총예산을 나눈다", () => {
  const scene = read("passthrough");
  const total = effectiveClaim(scene, "resource", 0, "power", "capacity")!;
  scene.claims[total]!.value = 45;
  const direct = scene.connections.find(c => c.id === "down")!;
  direct.from = scene.ports.findIndex(p => p.item === scene.resources[0]!.item && p.id === "b");
  const budget = scene.claims[effectiveClaim(scene, "item", scene.resources[0]!.item, "power", "budget:a:a")!]!;
  for (const port of ["a", "b"]) scene.claims.push({ ...budget, field: "budget:a+b:" + port });

  const { work } = analyze(scene);
  const one = work("solo", "primary");
  assert.equal(one.metric("together").value, 35);
  assert.ok(one.citations.includes("relay"));

  const sink = scene.interfaces.findIndex(i => i.id === "in-power");
  scene.claims[effectiveClaim(scene, "interface", sink, "power", "accepts20")!]!.value = false;
  const unavailable = analyze(scene);
  assert.deepEqual(unavailable.result.standingLoads, []);
  assert.equal(unavailable.work("solo", "primary").metric("together").value, 45);
});

test("T8 명시적인 미확인 소비와 목표는 가능한 순충전 판정과 확인 퀘스트로 남는다", () => {
  for (const [field, low, high, possible] of [
    ["loadW", null, 60, ["ok", "conditional", "impossible"]],
    ["targetW", 40, 40, ["ok", "conditional"]],
  ] as const) {
    const scene = read("single-port");
    const claim = effectiveClaim(scene, "workload", 0, "power", field)!;
    Object.assign(scene.claims[claim]!, { value: null, confidence: "unknown" });
    const { result, work } = analyze(scene);
    const a = work("single", "idle");
    assert.equal(a.verdict, "unknown");
    assert.equal(a.metric("together").value, 60);
    assert.deepEqual(result.assessments.filter(r => r.outcome === a.outcome && r.run === "together").map(r => r.verdict), possible);
    assert.deepEqual(result.measures.find(m => m.outcome === a.outcome && m.run === "together"),
      { outcome: a.outcome, run: "together", kind: "netCharge", unit: "W", low, high });
    assert.ok(result.quests.some(q => q.outcome === a.outcome && q.claim === claim));
    assert.ok(a.claims.includes(claim));
  }
});

test("T8 순충전 범위는 0과 목표를 포함해 분류하고 생략한 목표에는 0 W를 쓴다", () => {
  const charge = assessCharge({ low: 40, high: 80 }, 50, 30);
  assert.deepEqual(charge.possible, ["ok", "conditional", "impossible"]);
  assert.deepEqual(charge.metrics, [{ kind: "netCharge", unit: "W", low: -10, high: 30 }]);
  assert.deepEqual(assessCharge({ low: 50, high: 50 }, 50).possible, ["ok"]);
  assert.deepEqual(assessCharge({ low: 50, high: 50 }, 50, 1).possible, ["conditional"]);
  assert.deepEqual(assessCharge({ low: 10, high: 20 }, null).possible, ["ok", "impossible"]);
  assert.deepEqual(assessCharge({ low: 0, high: 0 }, 0, null).possible, ["ok", "conditional"]);
});

for (const state of ["5 W","한도 미확인","부착점 미확인","커넥터 미확인"]) test("T8 직결 출력에 반영하는 패스스루 입력 조건 · " + state, () => {
  const s = read("passthrough");
  s.claims[effectiveClaim(s,"resource",0,"power","capacity")!]!.value = 45;
  s.connections.find(c => c.id === "down")!.from = s.ports.findIndex(p => p.item === 0 && p.id === "b");
  const budget = s.claims[effectiveClaim(s,"item",0,"power","budget:a:a")!]!;
  const a = s.claims.push({...budget,field:"budget:a+b:a",value:state === "5 W" ? 5 : state === "한도 미확인" ? null : 60})-1;
  s.claims.push({...budget,field:"budget:a+b:b"});
  const attachment = effectiveClaim(s,"port",s.connections[0]!.from,"","attachment")!;
  const connector = effectiveClaim(s,"port",s.connections[0]!.from,"","connector")!;
  const uncertain = state === "부착점 미확인" ? attachment : state === "커넥터 미확인" ? connector : a;
  if (uncertain !== a) Object.assign(s.claims[uncertain]!,{value:null,reference:null,confidence:"unknown"});
  const {result,work} = analyze(s), w = work("solo","primary"), m = w.metric("together");
  assert.deepEqual([m.value,m.low,m.high],state === "5 W" ? [40,40,40] : [null,35,45]);
  if (state !== "5 W") assert.ok(result.quests.some(q => q.outcome === w.outcome && q.claim === uncertain));
  else assert.ok(w.claims.includes(a));
});

test("T8 입력 조합 한도가 0–60 W면 자체 소비 10 W 뒤의 입력은 0–50 W다", () => {
  const s = read("passthrough");
  const limit = effectiveClaim(s,"item",0,"power","budget:a:a")!;
  Object.assign(s.claims[limit]!,{value:null,confidence:"unknown"});
  const {result} = analyze(s);
  const input = result.options.find(o => o.connection === 0 && o.direction === "forward" && o.unit === "W")!;
  assert.deepEqual(input.bounds,{low:0,high:50});
  assert.ok(input.inputs.includes(limit));
});
