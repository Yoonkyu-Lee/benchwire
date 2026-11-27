// 미확인 배선·분배 정책의 범위, 가정, 검증 퀘스트를 파일에서 연 합성 장면으로 확인한다.
import { power } from "../domains/power/power.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadScene } from "../cli/load.ts";
import { trialDomain } from "../fixtures/trial.ts";
import { evaluate } from "./evaluate.ts";
import { effectiveClaim, portFacts, resourceFacts } from "./scene.ts";
import type { Results } from "./results.ts";

const trial = trialDomain();
function sample() {
  return loadScene("fixtures/three-flows.json", { modelsDir: "fixtures", connectorsFile: "fixtures/connectors.json" }, [trial]);
}
function output(r: Results, workload: number) {
  const row = r.outcomes.findIndex(o => o.subjectKind === "workload" && o.subjectRow === workload);
  const metric = (kind: string) => r.metrics.find(m => m.outcome === row && m.kind === kind)!;
  return { row, verdict: r.outcomes[row]!.verdict, metric, quests: r.quests.filter(q => q.outcome === row),
    possible: r.possibleVerdicts.filter(v => v.outcome === row).map(v => v.verdict).sort() };
}
function wiring() {
  const scene = sample();
  scene.members = scene.members.filter(m => m.workload < 2);
  scene.claims[effectiveClaim(scene, "workload", 0, trial.id, "rate")!]!.value = 800;
  const port = scene.connections[0]!.from, claim = portFacts(scene, port).attachment;
  scene.claims[claim] = { ...scene.claims[claim]!, value: null, attachmentNode: null };
  return { scene, claim };
}

test("T5 미확인 정책은 범위와 균등 분배 가정값을 따로 주고 원래 정책 주장을 확인하게 한다", () => {
  const scene = sample(), policy = resourceFacts(scene, 0).policy;
  scene.claims[policy]!.value = null;
  const r = evaluate(scene, [trial]);
  for (const [i, demand, fair] of [[0,100,100],[1,800,400],[2,800,400]] as const) {
    const o = output(r, i), m = o.metric("together");
    assert.deepEqual([o.verdict, m.low, m.high, m.value, m.basis], ["unknown", 0, demand, fair, "assumed"]);
    assert.equal(o.metric("solo").value, demand);
    assert.ok(o.quests.some(q => q.claim === policy && q.instruction === trial.quest("policy")));
    assert.deepEqual(o.possible, ["conditional", "impossible", "ok"]);
  }
  assert.equal(scene.claims[policy]!.value, null);
});

test("T5 미확인 부착점을 하나의 배선으로 고정해 경쟁 작업의 450과 800을 각각 재현한다", () => {
  const {scene, claim} = wiring(), r = evaluate(scene, [trial]), b = output(r, 1), m = b.metric("together");
  assert.deepEqual([b.verdict, m.low, m.high, m.value, m.range], ["unknown", 450, 800, null, "witnessed"]);
  assert.deepEqual(b.possible, ["conditional", "ok"]);
  assert.ok(b.quests.some(q => q.claim === claim));
  for (const [world, expected] of [[m.lowWorld, 450], [m.highWorld, 800]] as const) {
    const replay = structuredClone(scene);
    for (const witness of r.wirings.filter(w => w.world === world)) {
      replay.claims[witness.claim]!.attachmentNode = witness.node;
      replay.claims[witness.claim]!.value = replay.nodes[witness.node]!.id;
    }
    assert.equal(output(evaluate(replay, [trial]), 1).metric("together").value, expected);
  }
  scene.claims[effectiveClaim(scene, "workload", 1, trial.id, "rate")!]!.value = 1400;
  const stable = output(evaluate(scene, [trial]), 1);
  assert.deepEqual([stable.verdict, stable.metric("together").low, stable.metric("together").high], ["conditional", 450, 900]);
});

test("미확인 부품 진입 부착점의 후보마다 다른 내부 통과 자원을 쓴다", () => {
  const scene = sample(), part = scene.items.push({ ...scene.items[0]!, id: "part" }) - 1;
  const nodes = ["entry", "exit"].map(id => scene.nodes.push({ item: part, id, label: id, kind: "junction" }) - 1);
  const ports = nodes.map((node, i) => {
    const source = i === 0 ? scene.connections[0]!.to : scene.connections[0]!.from;
    const port = scene.ports.push({ ...scene.ports[source]!, item: part, id: String(i) }) - 1;
    const iface = scene.interfaces.findIndex(v => v.port === source);
    const copy = scene.interfaces.push({ ...scene.interfaces[iface]!, port }) - 1;
    for (const [row, c] of scene.claims.slice().entries()) {
      if (!(c.ownerKind === "port" && c.owner === source || c.ownerKind === "interface" && c.owner === iface)) continue;
      const claim = scene.claims.push({ ...c, owner: c.ownerKind === "port" ? port : copy }) - 1;
      scene.claimSources.push(...scene.claimSources.filter(s => s.claim === row).map(s => ({...s, claim})));
      if (c.field === "declaration") scene.interfaces[copy]!.evidence = claim;
      if (c.field === "attachment") Object.assign(scene.claims[claim]!, { value: i ? "exit" : null, attachmentNode: i ? node : null });
    }
    return port;
  });
  scene.parts.push({ connection: 0, order: 0, item: part, entry: ports[0]!, exit: ports[1]! });
  const edge = scene.edges.push({ ...scene.edges[0]!, id: "pass", item: part, from: nodes[0]!, to: nodes[1]! }) - 1;
  scene.resourceUses.push({ ...scene.resourceUses[0]!, edge });
  scene.claims[effectiveClaim(scene, "workload", 0, trial.id, "rate")!]!.value = 800;
  scene.members = scene.members.filter(m => m.workload === 0);
  const r = evaluate(scene, [trial]), o = output(r, 0);
  assert.deepEqual([o.metric("together").low, o.metric("together").high], [450, 800]);
  assert.deepEqual(new Set(r.wirings.filter(w => w.claim === portFacts(scene, ports[0]!).attachment).map(w => w.node)), new Set(nodes));
});

test("배선 조합 상한을 넘으면 일부 표본을 최선·최악으로 확정하지 않는다", () => {
  const { scene } = wiring();
  for (let i = 0; i < 100; i++) {
    const to = scene.nodes.push({ item: 0, id: "extra-" + i, label: "", kind: "junction" }) - 1;
    scene.edges.push({ ...scene.edges[0]!, id: "extra-edge-" + i, to });
  }
  const r = evaluate(scene, [trial]), o = output(r, 1);
  assert.equal(o.verdict, "unknown");
  assert.equal(o.metric("together").range, "conservative");
  assert.ok(r.reasons.some(v => v.outcome === o.row && v.rule.includes("배선 조합 상한")));
});

test("T8 물리 접속을 유지하고 켠 작업에 맞는 정책 행을 적용해 60 W와 50 W를 구한다", () => {
  const power = trialDomain("trial-power", "rate", "W");
  const scene = loadScene("fixtures/power-scene.json", { modelsDir: "fixtures", connectorsFile: "fixtures/connectors.json" }, [power]);
  const r = evaluate(scene, [power]);
  assert.deepEqual([0,1,2].map(i => [output(r,i).metric("solo").value, output(r,i).metric("together").value]), [[60,50],[30,30],[20,20]]);
  const first = output(r,0);
  assert.equal(first.verdict, "conditional");
  const soloPolicy = r.reasons.findIndex(v => v.outcome === first.row && v.rule === "단독 접속·활성 포트 조합표");
  assert.ok(scene.connections.every(c => r.reasonInputs.some(i => i.reason === soloPolicy && i.claim === c.evidence)));
  const inputs = r.reasonInputs.filter(i => r.reasons[i.reason]!.outcome === first.row).map(i => i.claim);
  for (const field of ["budget:a+b+c:a:a", "budget:a+b+c:a+b+c:a"]) {
    assert.ok(inputs.some(i => scene.claims[i]!.field === field && scene.claimSources.some(s => s.claim === i && scene.sources[s.source]!.locator === "fixture:power-policy")));
  }
});

test("연결은 선택한 옵션의 미사용 성능만 같은 단위와 근거로 기록한다", () => {
  const scene = sample();
  const plugin = { ...trial, negotiate(link: Parameters<typeof trial.negotiate>[0]) {
    const [option] = trial.negotiate(link);
    if (link.direction === "reverse") return [option!];
    return [{ ...option!, limit: 10, unused: 99 }, { ...option!, unused: 0 }];
  } };
  const r = evaluate(scene, [plugin]);
  for (const [row, o] of r.outcomes.entries()) {
    if (o.subjectKind !== "connection") continue;
    const metrics = r.metrics.filter(m => m.outcome === row && m.kind === "unused");
    assert.deepEqual(metrics.map(m => [m.value, m.low, m.high, m.unit, m.basis]),
      o.direction === "forward" ? [[0, 0, 0, "회/s", "calculated"]] : []);
    assert.ok(r.reasonInputs.some(i => r.reasons[i.reason]!.outcome === row && r.reasons[i.reason]!.stage === "negotiate"));
  }
});

test("알려진 매체 용량 0은 미확인 포트 한도보다 먼저 불가와 매체 병목을 확정한다", () => {
  const scene = sample(), medium = scene.resources.push({ ...scene.resources[0]!, id: "medium" }) - 1;
  for (const [row, c] of scene.claims.slice().entries()) {
    if (c.ownerKind !== "resource" || c.owner !== 0) continue;
    const claim = scene.claims.push({ ...c, owner: medium, value: c.field === "capacity" ? 0 : c.value }) - 1;
    scene.claimSources.push(...scene.claimSources.filter(s => s.claim === row).map(s => ({ ...s, claim })));
  }
  const plugin = { ...trial, negotiate: (link: Parameters<typeof trial.negotiate>[0]) =>
    trial.negotiate(link).map(o => ({ ...o, limit: null, verdict: "unknown" as const })),
    consume: (...args: Parameters<typeof trial.consume>) => {
      const uses = trial.consume(...args);
      return args[1] === 0 ? [...uses, { ...uses[0]!, resource: medium }] : uses;
    } };
  const r = evaluate(scene, [plugin]), first = output(r, 0);
  assert.deepEqual([first.verdict, first.metric("solo").value, first.metric("together").value], ["impossible", 0, 0]);
  assert.ok(r.bindings.some(b => b.workload === 0 && b.run === "together" && b.resourceKind === "scene" && b.resource === medium));
  assert.ok(r.reasonInputs.some(i => r.reasons[i.reason]!.outcome === first.row && i.claim === resourceFacts(scene, medium).capacity));
  assert.equal(output(r, 1).verdict, "unknown");
});

test("비유한 플러그인 한도·수요·소비는 계약 오류를 남기고 미확인으로 계산한다", () => {
  const scene = sample();
  for (const [entryPoint, field, overrides] of [
    ["negotiate", "limit", { negotiate: (link: Parameters<typeof trial.negotiate>[0]) =>
      trial.negotiate(link).map(o => ({ ...o, limit: Infinity })) }],
    ["demand", "requested", { demand: (...args: Parameters<typeof trial.demand>) =>
      trial.demand(...args).map(d => ({ ...d, requested: NaN })) }],
    ["consume", "coefficient", { consume: (...args: Parameters<typeof trial.consume>) =>
      trial.consume(...args).map(u => ({ ...u, coefficient: -Infinity })) }],
    ["consume", "fixed", { consume: (...args: Parameters<typeof trial.consume>) =>
      trial.consume(...args).map(u => ({ ...u, fixed: Infinity })) }],
  ] as const) {
    const r = evaluate(scene, [{ ...trial, ...overrides }]);
    assert.ok(r.errors.some(e => e.domain === trial.id && e.entryPoint === entryPoint && e.field === field), field);
    assert.deepEqual([output(r, 0).verdict, output(r, 0).metric("together").value], ["unknown", null], field);
    assert.ok(r.metrics.every(m => [m.low, m.high, m.value].every(v => v === null || Number.isFinite(v))));
  }
});

test("T8 켠 작업에 맞는 정책 한도가 비거나 비유한 값이면 성능을 미확인으로 남긴다", () => {
  const power = trialDomain("trial-power", "rate", "W");
  const scene = loadScene("fixtures/power-scene.json", { modelsDir: "fixtures", connectorsFile: "fixtures/connectors.json" }, [power]);
  for (const invalid of [false, true]) {
    const plugin = { ...power, policy: (context: Parameters<NonNullable<typeof power.policy>>[0]) =>
      invalid ? power.policy!(context)!.map(p => ({ ...p, limit: Infinity })) : [] };
    const r = evaluate(scene, [plugin]);
    assert.deepEqual([output(r,0).verdict, output(r,0).metric("together").value], ["unknown", null]);
    if (invalid) assert.ok(r.errors.some(e => e.entryPoint === "policy" && e.targetKind === "path" && e.resource === 0 && r.paths[e.row] && e.field === "limit"));
  }
});

test("T8 정책표의 확정 한도 0은 미확인 링크에서도 작업 불가의 출처로 남는다", () => {
  const power = trialDomain("trial-power", "rate", "W");
  const scene = loadScene("fixtures/power-scene.json", { modelsDir: "fixtures", connectorsFile: "fixtures/connectors.json" }, [power]);
  for (const c of scene.claims) {
    if (c.field === "budget:a+b+c:a:a" || c.field === "budget:a+b+c:a+b+c:a") c.value = 0;
    if (c.ownerKind === "interface" && c.field === "rate") c.value = null;
  }
  const r = evaluate(scene, [power]), first = output(r, 0);
  assert.deepEqual([first.verdict, first.metric("solo").value, first.metric("together").value], ["impossible", 0, 0]);
  assert.ok(r.bindings.some(b => b.run === "together" && b.workload === 0 && b.resourceKind === "scene" && b.resource === 0));
});

test("T8 조합표의 개별 한도 합이 물리 예산을 넘으면 잔여 분배를 확정하지 않는다", () => {
  const power = trialDomain("trial-power", "rate", "W");
  const scene = loadScene("fixtures/power-scene.json", { modelsDir: "fixtures", connectorsFile: "fixtures/connectors.json" }, [power]);
  const policy = resourceFacts(scene, 0).policy;
  scene.claims[effectiveClaim(scene, "item", 0, power.id, "budget:a+b+c:a+b+c:a")!]!.value = 100;
  const r = evaluate(scene, [power]), o = output(r, 0), m = o.metric("together");
  assert.deepEqual([o.verdict, m.basis, m.value, m.low, m.high], ["unknown", "assumed", 50, 0, 60]);
  assert.ok(o.quests.some(q => q.claim === policy));
});

test("T5 경로 열거가 잘려도 다른 장비 묶음의 부착점 퀘스트는 생기지 않는다", () => {
  const scene = sample();
  const chosen = scene.workloads[0]!;
  const source = scene.nodes.push({ item: scene.ports[scene.connections[0]!.to]!.item, id: "local-a", kind: "junction", label: "" }) - 1;
  const end = scene.nodes.push({ ...scene.nodes[source]!, id: "local-b" }) - 1;
  chosen.from = source; chosen.to = end;
  scene.members = scene.members.slice(0,1);
  for (let i = 0; i < 70; i++) scene.edges.push({ ...scene.edges[0]!, item: scene.nodes[source]!.item, id: "local-" + i, from: source, to: end });
  const port = scene.connections[2]!.to, claim = portFacts(scene, port).attachment;
  Object.assign(scene.claims[claim]!, { value: null, attachmentNode: null });
  for (let i = 0; i < 70; i++) {
    const n = scene.nodes.push({ item: scene.ports[port]!.item, id: "remote-" + i, kind: "junction", label: "" }) - 1;
    scene.edges.push({ ...scene.edges[0]!, item: scene.ports[port]!.item, from: n, to: scene.workloads[2]!.to });
  }
  const r = evaluate(scene, [trial]), a = output(r,0);
  assert.ok(r.reasons.some(v => v.outcome === a.row && v.rule === "경로 후보 열거 상한"));
  assert.ok(!a.quests.some(q => q.claim === claim));
});

test("T8 충전 목표가 성립해도 전달 전력과 순충전 범위를 좁히는 케이블 전류를 확인한다", () => {
  const scene = loadScene("fixtures/power/single-port.json",{ modelsDir: "fixtures/power", connectorsFile: "fixtures/power/connectors.json" },[power]);
  const currents: number[] = [];
  scene.claims.forEach((c,i) => {
    if (c.field === "eMarked") c.value = true;
    if (c.field === "currentA") { c.value = null; c.confidence = "unknown"; currents.push(i); }
  });
  const plugin: typeof power = { ...power, assess: power.assess ?? ((_s,_w,_d,_steps,p) => ({
    possible: p.low !== null && p.low >= 50 ? ["ok"] : ["conditional","ok"],
    metrics: [{ kind: "net", unit: "W", low: p.low === null ? null : p.low-20, high: p.high === null ? null : p.high-20 }],
    rule: "대기 소비 20 W와 목표 30 W", inputs: [], specs: [],
  })) };
  const r = evaluate(scene,[plugin]), row = r.outcomes.findIndex(o => o.subjectKind === "workload");
  assert.equal(r.outcomes[row]!.verdict,"ok");
  const m = r.metrics.find(m => m.outcome === row && m.kind === "together")!;
  assert.deepEqual([m.low,m.high],[60,80]);
  assert.ok(r.measures.some(m => m.outcome === row && m.low === 40 && m.high === 60));
  assert.ok(r.quests.some(q => q.outcome === row && q.impact === "range" && currents.includes(q.claim)));
  scene.claims.find(c => c.field === "requestedW")!.value = 50;
  const fixed = evaluate(scene,[plugin]);
  assert.equal(fixed.quests.some(q => fixed.outcomes[q.outcome]!.subjectKind === "workload" && currents.includes(q.claim)),false);
});
