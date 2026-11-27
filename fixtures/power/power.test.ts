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
    const root = result.reasons.findIndex(reason => reason.outcome === outcome && reason.stage === "judge");
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

test("T8 세 포트에서 50·30·20 W를 전달하고 다른 작업만 꺼도 A의 50 W가 유지된다", () => {
  const scene = read("three-ports");
  const { work } = analyze(scene);
  for (const [scenario, load, verdict, net] of [
    ["idle", 20, "ok", 30], ["normal", 45, "conditional", 5], ["max", 70, "impossible", -20],
  ] as const) {
    const a = work(scenario);
    assert.equal(a.metric("solo").value, 50);
    assert.equal(a.metric("together").value, 50);
    assert.equal(a.verdict, "conditional");
    const loadW = scene.claims[effectiveClaim(scene, "workload", a.workload, "power", "loadW")!]!.value;
    const targetW = scene.claims[effectiveClaim(scene, "workload", a.workload, "power", "targetW")!]!.value;
    assert.equal(loadW, load);
    assert.equal(targetW, 30);
    const charge = assessCharge(a.metric("together"), loadW, targetW);
    assert.deepEqual(charge.possible, [verdict]);
    assert.deepEqual(charge.metrics, [{ kind: "netCharge", unit: "W", value: net, low: net, high: net }]);
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
});

test("T8 다른 포트를 분리하면 전자 표지가 없는 케이블이 20 V·3 A와 60 W를 제한한다", () => {
  const scene = read("single-port");
  for (const claim of cableClaim(scene, "currentA")) Object.assign(scene.claims[claim]!, { value: null, confidence: "unknown" });
  const { result, work } = analyze(scene);
  const a = work("single", "idle");
  assert.equal(a.verdict, "conditional");
  assert.equal(a.metric("together").value, 60);
  assert.ok(a.reasons.some(r => r.stage === "negotiate" && /20 V · 3 A · 60 W/.test(r.rule)));
  assert.ok(a.citations.includes("cable-3a"));
  assert.ok(a.specs.includes("type-c-cable"));
  assert.ok(result.bindings.some(b => b.run === "together" && b.resourceKind === "link"));
});

test("T8 e-marker 전류가 미확인이면 60–80 W와 확인 퀘스트가 남는다", () => {
  const scene = read("single-port");
  for (const claim of cableClaim(scene, "eMarked")) scene.claims[claim]!.value = true;
  const currents = cableClaim(scene, "currentA");
  for (const claim of currents) Object.assign(scene.claims[claim]!, { value: null, confidence: "unknown" });
  const { result, work } = analyze(scene);
  const a = work("single", "idle");
  assert.equal(a.verdict, "unknown");
  assert.equal(a.metric("together").value, null);
  assert.deepEqual([a.metric("together").low, a.metric("together").high], [60, 80]);
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
  const { work } = analyze(read("passthrough"));
  const one = work("solo", "primary");
  assert.equal(one.metric("together").value, 50);
  assert.equal(work("shared", "primary").metric("together").value, 25);
  assert.equal(work("shared", "secondary").metric("together").value, 25);
  assert.ok(one.reasons.some(r => r.stage === "negotiate" && /자체 소비 10 W/.test(r.rule)));
  assert.ok(one.citations.includes("relay"));
  assert.ok(one.specs.includes("pd-fixed"));
});

test("T8 순충전 범위는 0과 목표를 포함해 분류하고 생략한 목표에는 0 W를 쓴다", () => {
  const charge = assessCharge({ low: 40, high: 80 }, 50, 30);
  assert.deepEqual(charge.possible, ["ok", "conditional", "impossible"]);
  assert.deepEqual(charge.metrics, [{ kind: "netCharge", unit: "W", value: null, low: -10, high: 30 }]);
  assert.deepEqual(assessCharge({ low: 50, high: 50 }, 50).possible, ["ok"]);
  assert.deepEqual(assessCharge({ low: 50, high: 50 }, 50, 1).possible, ["conditional"]);
  assert.deepEqual(assessCharge({ low: 10, high: 20 }, null).possible, ["ok", "impossible"]);
  assert.deepEqual(assessCharge({ low: 0, high: 0 }, 0, null).possible, ["ok", "conditional"]);
});
