// 운반 서비스와 공용 예산을 다른 영역에서 쓰는 경로의 성능·판정·출처를 검산한다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadScene } from "../cli/load.ts";
import { trialDomain } from "../fixtures/trial.ts";
import type { DomainPlugin, Pool } from "./contract.ts";
import { evaluate } from "./evaluate.ts";

function setup(amounts: number[], limit: number | null = 100, scope: Pool["scope"] = "direction", unit = "MB/s") {
  const trial = trialDomain();
  const scene = loadScene("fixtures/three-flows.json", { modelsDir: "fixtures", connectorsFile: "fixtures/connectors.json" }, [trial]);
  const c = scene.connections[0]!;
  const node = (port: number) => scene.claims.find(claim => claim.ownerKind === "port" && claim.owner === port && claim.field === "attachment")!.reference!;
  const template = scene.claims.findIndex(claim => claim.ownerKind === "workload" && claim.field === "rate");
  const sources = scene.claimSources.filter(s => s.claim === template);
  const requests = amounts.map((value, owner) => {
    const claim = scene.claims.push({ ...scene.claims[template]!, id: "요청-" + owner, domain: "client", owner, value, unit }) - 1;
    scene.claimSources.push(...sources.map(s => ({ ...s, claim })));
    return claim;
  });
  const request = requests[0]!;
  const capacity = scene.claims.findIndex(claim => claim.field === "capacity");
  const budgetUnit = unit === "W" ? "W" : "Gbps";
  Object.assign(scene.claims[capacity]!, { value: limit, unit: budgetUnit });
  scene.workloads = amounts.map((_, i) => ({ id: "작업" + i, kind: "copy", domain: "client", from: node(c.from), to: node(c.to) }));
  scene.members = amounts.map((_, workload) => ({ scenario: 0, workload }));
  const carrier: DomainPlugin = { ...trial, sources: ["service","budget"].map(id => ({ id, title: id, locator: "fixture:" + id })),
    negotiate: link => ["bulk","video"].map(mode => ({ mode, unit: mode === "video" ? "Gbps" : unit, limit: 4000,
      verdict: "ok", condition: "", rule: "운반 서비스", inputs: [link.scene.connections[link.connection]!.evidence], specs: ["service"],
      pool: { domain: trial.id, id: "wire", perUnit: mode === "video" || unit === "W" ? 1 : 0.008 } })),
    pools: () => [{ id: "wire", scope, limit, unit: budgetUnit, rule: "케이블 예산", inputs: [capacity], specs: ["budget"] }],
  };
  const client: DomainPlugin = { ...trialDomain("client"), negotiate: () => [], consume: () => [],
    demand: (s, w) => [{ mode: "copy", unit, preference: 0, requested: Number(s.claims[requests[w]!]!.value), elastic: true, via: [],
      carriers: [{ domain: "trial", mode: "bulk" }], rule: "작업 요청", inputs: [requests[w]!], specs: ["pulse"] }],
  };
  function run() {
    const r = evaluate(scene, [client, carrier]);
    const row = (workload: number) => r.outcomes.findIndex(o => o.subjectKind === "workload" && o.subjectRow === workload);
    const values = (run: "together" | "solo") => amounts.map((_, i) => r.metrics.find(m => m.outcome === row(i) && m.kind === run)!.value);
    return { r, row, values };
  }
  return { scene, client, carrier, run, request, requests, capacity };
}

for (const scope of ["direction","connection"] as const) test("T4 반대 방향의 공용 예산 범위 " + scope, () => {
  const { scene, carrier, run } = setup([100,100,100], 0.8, scope);
  const w = scene.workloads[2]!;
  [w.from, w.to] = [w.to, w.from];
  // 세 번째는 운반 영역 자체의 작업이다.
  w.domain = carrier.id;
  carrier.consume = () => [];
  carrier.demand = () => [{ mode: "bulk", unit: "MB/s", preference: 0, requested: 100, elastic: true, via: [], rule: "전송 요청", inputs: [], specs: ["service"] }];
  const { values, r, row } = run();
  assert.deepEqual(values("solo"), [100,100,100]);
  const expected = scope === "direction" ? [50,50,100] : [100/3,100/3,100/3];
  values("together").forEach((v,i) => assert.ok(v !== null && Math.abs(v - expected[i]!) < 1e-10));
  const specs = r.reasonSpecs.filter(s => r.reasons[s.reason]!.outcome === row(0)).map(s => r.specSources[s.source]!);
  for (const [domain,id] of [["client","pulse"],["trial","service"],["trial","budget"]])
    assert.ok(specs.some(s => s.domain === domain && s.id === id));
  assert.ok(r.reasonSpecs.every(s => s.source >= 0));
});

test("T4 하나의 28 Gbps 터널에서 16·8 Gbps 예약 뒤 두 탄력 작업은 400·100 MB/s를 얻는다", () => {
  const { scene, client, run, requests } = setup([16,8,800,100], 28);
  for (const row of requests.slice(0,2)) scene.claims[row]!.unit = "Gbps";
  const demand = client.demand;
  client.demand = (s,w) => demand(s,w).map(d => w < 2 ? { ...d, unit: "Gbps", elastic: false,
    carriers: [{ domain: "trial", mode: "video" }] } : d);
  const { r, values } = run();
  const pool = r.resourceUsage.find(u => u.scenario === 0 && u.resourceKind === "link" &&
    r.linkResources[u.resource]!.pool?.id === "wire" && r.linkResources[u.resource]!.connection === 0)!;
  assert.deepEqual([pool.unit,pool.used,pool.capacity],["Gbps",28,28]);
  assert.ok(pool.reasonRows.some(row => r.reasonInputs.some(i => i.reason === row)));
  assert.deepEqual(values("solo"), [16,8,800,100]);
  values("together").forEach((v,i) => assert.ok(v !== null && Math.abs(v - [16,8,400,100][i]!) < 1e-9));
});

test("T4 공용 예산의 미확인 범위와 알려진 0에 예산 주장이 남는다", () => {
  for (const limit of [null,0]) {
    const { carrier, run, capacity } = setup([100], limit);
    const pools = carrier.pools!;
    carrier.pools = link => pools(link).map(p => limit === null ? { ...p, bounds: { low: 0.32, high: 0.8 } } : p);
    const { r, row } = run(), outcome = row(0);
    const m = r.metrics.find(m => m.outcome === outcome && m.kind === "together")!;
    assert.deepEqual([r.outcomes[outcome]!.verdict,m.low,m.high], limit === null ? ["unknown",40,100] : ["impossible",0,0]);
    assert.ok(r.reasonInputs.some(i => i.claim === capacity && r.reasons[i.reason]!.outcome === outcome));
    if (limit === null) assert.ok(r.quests.some(q => q.outcome === outcome && q.claim === capacity));
  }
});

test("T4 경유점 앞뒤에서 다른 운반 서비스를 쓰고 같은 반이중 예산을 두 번 지난다", () => {
  const { scene, client, carrier, run } = setup([100], 0.8, "connection");
  const w = scene.workloads[0]!, via = w.to;
  w.to = w.from;
  const demand = client.demand, negotiate = carrier.negotiate;
  client.demand = (s,i) => demand(s,i).map(d => ({ ...d, via: [via], carriers: [{ domain: "trial", mode: "out" },{ domain: "trial", mode: "back" }] }));
  carrier.negotiate = link => negotiate(link).slice(0,1).map(o => ({ ...o, mode: link.direction === "forward" ? "out" : "back" }));
  assert.deepEqual(run().values("together"), [50]);
});

test("T10 작업 영역의 match가 맞는 서비스 후보를 고르고 거절 규칙과 출처를 남긴다", () => {
  const { client, carrier, run, request } = setup([100]);
  let permit = true;
  const negotiate = carrier.negotiate;
  carrier.negotiate = link => negotiate(link).filter(o => o.mode === "bulk").flatMap(o => [o, { ...o, limit: 2000 }]);
  client.match = (_link, o, d) => ({ verdict: permit && d.mode === "copy" && o.limit === 2000 ? "ok" : "impossible",
    rule: o.limit === 4000 ? "상위 후보 거절" : "요청의 목표 확인", inputs: [request], specs: ["pulse"] });
  const allowed = run();
  assert.deepEqual(allowed.values("together"), [100]);
  const rejected = allowed.r.reasons.findIndex(p => p.outcome === allowed.row(0) && p.rule === "상위 후보 거절");
  assert.ok(allowed.r.reasonInputs.some(i => i.reason === rejected && i.claim === request));
  assert.ok(allowed.r.reasonSpecs.some(i => i.reason === rejected && allowed.r.specSources[i.source]?.domain === "client"));
  permit = false;
  const { r, row } = run();
  assert.equal(r.outcomes[row(0)]!.verdict, "impossible");
  const proof = r.reasons.findIndex(p => p.outcome === row(0) && p.rule === "상위 후보 거절");
  assert.ok(r.reasonInputs.some(i => i.reason === proof && i.claim === request));
  assert.ok(r.reasonSpecs.some(i => i.reason === proof && r.specSources[i.source]?.domain === "client"));
});

test("T8 assess는 단독·동시의 양수 전달량과 음수 순충전량을 함께 남긴다", () => {
  const { client, run, request } = setup([100,100], 100, "direction", "W");
  client.assess = (_s,_w,_d,_steps,p) => {
    const net = (v: number | null) => v === null ? null : v - 70;
    return { possible: [p.low !== null && p.low >= 70 ? "ok" : "impossible"], metrics: [{ kind: "net", unit: "W", low: net(p.low), high: net(p.high) }],
      rule: "목표 순충전", inputs: [request], specs: ["pulse"] };
  };
  const { r, row, values } = run(), outcome = row(0);
  assert.deepEqual(values("together"), [50,50]);
  assert.equal(r.outcomes[outcome]!.verdict, "impossible");
  assert.deepEqual(r.possibleVerdicts.filter(v => v.outcome === outcome).map(v => v.verdict), ["impossible"]);
  assert.deepEqual(r.measures.filter(m => m.outcome === outcome).map(m => [m.run,m.kind,m.low,m.high]), [["solo","net",30,30],["together","net",-20,-20]]);
  assert.ok(r.reasons.some(p => p.outcome === outcome && p.rule === "목표 순충전"));
});

test("T8 배선마다 목표 판정이 같아도 단독·동시 파생 지표의 경계와 퀘스트를 합친다", () => {
  const { scene, client, run } = setup([100], 100, "direction", "W");
  const attachment = scene.claims.findIndex(c => c.ownerKind === "port" && c.owner === scene.connections[0]!.from && c.field === "attachment");
  const knownNode = scene.claims[attachment]!.reference;
  Object.assign(scene.claims[attachment]!, { reference: null, value: null });
  client.assess = (s) => {
    const net = s.claims[attachment]!.reference === knownNode ? 20 : 5;
    return { possible: ["conditional"], metrics: [{ kind: "net", unit: "W", low: net, high: net }],
      rule: "배선별 순충전", inputs: [attachment], specs: [] };
  };
  // 어느 부착점에서도 작업을 보낼 수 있다.
  scene.edges.push({ ...scene.edges[0]!, from: scene.edges[0]!.to, to: scene.edges[0]!.from });
  const { r, row } = run(), outcome = row(0);
  assert.equal(r.outcomes[outcome]!.verdict, "conditional");
  assert.deepEqual(r.measures.filter(m => m.outcome === outcome).map(m => [m.low,m.high]), [[5,20],[5,20]]);
  assert.ok(r.quests.some(q => q.outcome === outcome && q.claim === attachment));
});

test("T4 공용 예산에 경계가 없어도 알려진 서비스 한도가 미확인 작업의 상한이다", () => {
  const { carrier, run } = setup([100], null);
  const negotiate = carrier.negotiate;
  carrier.negotiate = link => negotiate(link).map(o => ({ ...o, limit: 60 }));
  const { r, row } = run(), outcome = row(0);
  const m = r.metrics.find(m => m.outcome === outcome && m.kind === "together")!;
  assert.deepEqual([r.outcomes[outcome]!.verdict,m.low,m.high], ["unknown",0,60]);
  assert.deepEqual(r.possibleVerdicts.filter(v => v.outcome === outcome).map(v => v.verdict).sort(), ["conditional","impossible"]);
});

test("T8 미확인 예산의 전달량 전체가 같은 충전 판정이면 assess가 계산한 가능한 판정만 남는다", () => {
  const { client, run } = setup([100], null, "direction", "W");
  client.assess = (_s,_w,_d,_steps,p) => ({ possible: ["conditional"], metrics: [{ ...p, kind: "부하", unit: "W" }],
    rule: "전체 범위에서 목표 미달", inputs: [], specs: [] });
  const { r, row } = run(), outcome = row(0);
  assert.deepEqual(r.possibleVerdicts.filter(v => v.outcome === outcome).map(v => v.verdict), ["conditional"]);
  assert.deepEqual(r.measures.filter(m => m.outcome === outcome).map(m => [m.low,m.high]), [[0,100],[0,100]]);
});

test("T4 다른 영역이 발행한 옵션도 같은 케이블 예산만 한 번 쓴다", () => {
  const { scene, client, carrier, run } = setup([100,100], 0.8);
  scene.interfaces.push(...scene.interfaces.map(i => ({ ...i, domain: client.id })));
  client.negotiate = link => carrier.negotiate(link).slice(0,1).map(o => ({ ...o, specs: ["pulse"] }));
  const demand = client.demand;
  client.demand = (s,w) => demand(s,w).map(d => w === 0 ? { ...d, carriers: [{ domain: client.id, mode: "bulk" }] } : d);
  const { values, r } = run();
  assert.deepEqual(values("together"), [50,50]);
  assert.ok(r.reasonSpecs.every(p => p.source >= 0));
  assert.deepEqual(r.errors, []);
});

test("T10 경유점·운반 구간·예산 참조 오류는 해당 작업이나 링크에 남는다", () => {
  for (const field of ["via","carriers","pool.id","pool.perUnit"]) {
    const { client, carrier, run } = setup([100]);
    const demand = client.demand, negotiate = carrier.negotiate;
    if (field === "via") client.demand = (s,w) => demand(s,w).map(d => ({ ...d, via: [-1] }));
    if (field === "carriers") client.demand = (s,w) => demand(s,w).map(d => ({ ...d, carriers: [] }));
    if (field.startsWith("pool.")) carrier.negotiate = link => negotiate(link).map(o => ({ ...o, pool: {
      ...o.pool!, ...(field === "pool.id" ? { id: "없는 예산" } : { perUnit: Infinity }) } }));
    const { r, row } = run();
    assert.equal(r.outcomes[row(0)]!.verdict, "unknown");
    assert.ok(r.errors.some(e => e.field === field && (e.stage === "demand" ? e.row === 0 : r.linkResources[e.row]?.domain === carrier.id)));
  }
});

test("T4 예산의 보장 하한은 서비스 자체의 미확인이나 물리 결합의 미확인을 덮지 않는다", () => {
  for (const missing of ["service","connector"]) {
    const { scene, carrier, run } = setup([25], null);
    const pools = carrier.pools!;
    carrier.pools = link => pools(link).map(p => ({ ...p, bounds: { low: 0.4, high: 0.8 } }));
    if (missing === "service") {
      const negotiate = carrier.negotiate;
      carrier.negotiate = link => negotiate(link).map(o => ({ ...o, verdict: "unknown" }));
    } else {
      const c = scene.claims.find(c => c.ownerKind === "port" && c.owner === scene.connections[0]!.from && c.field === "connector")!;
      Object.assign(c, { value: null, reference: null });
    }
    const { r, row } = run();
    assert.equal(r.outcomes[row(0)]!.verdict, "unknown");
    assert.equal(r.metrics.find(m => m.outcome === row(0) && m.kind === "together")!.value, null);
  }
});

test("T4 한 공용 예산의 탄력 수요가 서로 다른 단위면 숫자만 같게 배분하지 않는다", () => {
  const { client, run } = setup([1,100], 0.8);
  const demand = client.demand;
  client.demand = (s,w) => demand(s,w).map(d => w === 0 ? { ...d, unit: "Gbps", carriers: [{ domain: "trial", mode: "video" }] } : d);
  const { r, values } = run();
  assert.deepEqual(values("together"), [null,null]);
  assert.ok(r.errors.some(e => e.field === "pool.elasticUnit"));
});

test("T7 한 영역·연결·방향의 12 W와 900 Mbps가 독립으로 성립하고 연결 판정도 각각 보인다", () => {
  const { scene, carrier, run } = setup([12,900]);
  scene.workloads.forEach(w => w.domain = carrier.id);
  delete carrier.pools;
  carrier.negotiate = () => [
    { mode: "supply", unit: "W", limit: 15, verdict: "ok", condition: "", rule: "전력 한도", inputs: [], specs: ["service"] },
    { mode: "payload", unit: "Mbps", limit: 975, verdict: "ok", condition: "", rule: "페이로드 한도", inputs: [], specs: ["service"] },
  ];
  carrier.demand = (_s,w) => [{ mode: w ? "payload" : "supply", unit: w ? "Mbps" : "W", requested: w ? 900 : 12,
    via: [], elastic: true, preference: 0, rule: "요청", inputs: [], specs: ["service"] }];
  carrier.consume = () => [];
  const { r, row, values } = run();
  assert.deepEqual(values("solo"), [12,900]);
  assert.deepEqual(values("together"), [12,900]);
  assert.deepEqual([r.outcomes[row(0)]!.verdict,r.outcomes[row(1)]!.verdict], ["ok","ok"]);
  const connection = r.outcomes.filter(o => o.subjectKind === "connection" && o.subjectRow === 0 && o.direction === "forward" && o.domain === carrier.id);
  assert.deepEqual(connection.map(o => [o.unit,o.mode,o.verdict]).sort(), [["Mbps","payload","ok"],["W","supply","ok"]]);
  const negotiate = carrier.negotiate;
  carrier.negotiate = link => negotiate(link).map(o => o.unit === "W" ? { ...o, limit: 0 } : o);
  assert.deepEqual(run().values("together"), [0,900]);
});

test("T3 배선 후보가 연결의 추가 단위를 열어도 같은 작업의 결과끼리 비교한다", () => {
  const { scene, carrier, run } = setup([100], 0.8);
  const attachment = scene.claims.findIndex(c => c.ownerKind === "port" && c.owner === scene.connections[0]!.from && c.field === "attachment");
  const original = scene.claims[attachment]!.reference;
  Object.assign(scene.claims[attachment]!, { reference: null, value: null });
  scene.edges.push({ ...scene.edges[0]!, from: scene.edges[0]!.to, to: scene.edges[0]!.from });
  const negotiate = carrier.negotiate;
  carrier.negotiate = link => {
    const options = negotiate(link).slice(0,1);
    if (link.scene.claims[attachment]!.reference === original) options.push({ ...options[0]!, mode: "supply", unit: "W" });
    return options;
  };
  const { r, row, values } = run();
  assert.deepEqual(values("together"), [100]);
  assert.equal(r.outcomes[row(0)]!.mode, "copy");
});

test("T4 단위와 서비스 이름까지 같아도 독립 예산 ID의 연결 판정과 배분은 나뉜다", () => {
  const { client, carrier, run } = setup([100,100], 0.8);
  const pools = carrier.pools!, negotiate = carrier.negotiate;
  carrier.pools = link => pools(link).flatMap(p => [p, { ...p, id: "두 번째" }]);
  carrier.negotiate = link => negotiate(link).slice(0,1).flatMap(o => [o, { ...o, pool: { ...o.pool!, id: "두 번째" } }]);
  client.match = (_link,o,_d,w) => ({ verdict: o.pool?.id === (w ? "두 번째" : "wire") ? "ok" : "impossible",
    rule: "지정 예산", inputs: [], specs: [] });
  const { r, values } = run();
  assert.deepEqual(values("together"), [100,100]);
  const groups = r.outcomes.filter(o => o.subjectKind === "connection" && o.subjectRow === 0 && o.direction === "forward");
  assert.deepEqual(groups.map(o => o.pool?.id).sort(), ["wire","두 번째"]);
});

test("T8 전달 범위가 충전 경계를 가로지르면 assess의 두 판정과 음수 경계를 보존한다", () => {
  const { client, carrier, request, run } = setup([100], null, "direction", "W");
  const pools = carrier.pools!;
  carrier.pools = link => pools(link).map(p => ({ ...p, bounds: { low: 40, high: 60 } }));
  client.assess = (_s,_w,_d,_steps,p) => ({ possible: ["impossible","conditional"],
    metrics: [{ kind: "net", unit: "W", low: p.low! - 50, high: p.high! - 50 }], rule: "충전 범위", inputs: [request], specs: [] });
  const { r, row } = run(), outcome = row(0);
  assert.deepEqual(r.possibleVerdicts.filter(v => v.outcome === outcome).map(v => v.verdict).sort(), ["conditional","impossible"]);
  assert.equal(r.outcomes[outcome]!.verdict, "unknown");
  assert.deepEqual(r.measures.filter(m => m.outcome === outcome).map(m => [m.low,m.high]), [[-10,10],[-10,10]]);
});

test("T4 역환산을 유한하게 표현할 수 없는 운반 단위는 계약 오류와 미확인으로 남는다", () => {
  const {client, run} = setup([100]);
  const demand = client.demand;
  client.demand = (scene,work) => demand(scene,work).map(d => ({...d,
    carriers:[{domain:"trial",mode:"bulk",conversion:{unit:"MB/s",perUnit:Number.MIN_VALUE}}]}));
  const {r,row} = run();
  assert.ok(r.errors.some(e => e.stage === "demand" && e.field === "carriers"));
  assert.equal(r.outcomes[row(0)]!.verdict,"unknown");
});
