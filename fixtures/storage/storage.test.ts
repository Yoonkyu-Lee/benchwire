// 저장장치 복사의 배선·한도·수요가 판정과 출처까지 이어지는지 합성 장면으로 확인한다.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { modelFile, sceneFile } from "../../cli/files.ts";
import { loadScene } from "../../cli/load.ts";
import { storageDomain } from "../../domains/storage/copy.ts";
import { evaluate } from "../../engine/evaluate.ts";

const dir = fileURLToPath(new URL(".", import.meta.url));
function read(name: string): unknown { return JSON.parse(readFileSync(join(dir, name + ".json"), "utf8")); }

function run(file: string, modelsDir = dir) {
  const plugins = [storageDomain];
  const scene = loadScene(file, { modelsDir, connectorsFile: join(dir, "connectors.json") }, plugins);
  const result = evaluate(scene, plugins);
  const copies = result.outcomes.flatMap((o, outcome) => {
    if (o.subjectKind !== "workload") return [];
    const root = result.reasons.findIndex(r => r.outcome === outcome && r.stage === "judge");
    assert.notEqual(root, -1);
    const ancestors = new Set([root]);
    for (const reason of ancestors) for (const p of result.reasonParents) if (p.reason === reason) ancestors.add(p.prior);
    const proof = [...ancestors].map(i => {
      const reason = result.reasons[i]!;
      const claims = result.reasonInputs.filter(r => r.reason === i).map(r => {
        const sources = scene.claimSources.filter(s => s.claim === r.claim).map(s => scene.sources[s.source]!.locator);
        assert.ok(sources.length);
        return { ...scene.claims[r.claim]!, sources };
      });
      assert.ok(claims.length || result.reasonParents.some(p => p.reason === i));
      return { ...reason, claims };
    });
    const metrics = ["solo", "together", "drop", "dropPercent"].map(kind => result.metrics.find(m => m.outcome === outcome && m.kind === kind)!);
    assert.deepEqual(metrics.map(m => m.unit), ["MB/s", "MB/s", "MB/s", "%"]);
    const bindings = result.bindings.filter(b => b.workload === o.subjectRow && b.scenario === o.scenario && b.run === "together");
    return { outcome, id: scene.workloads[o.subjectRow]!.id, verdict: o.verdict, proof, bindings, metrics: metrics.map(m => m.value) };
  });
  assert.deepEqual(result.errors, []);
  return { scene, result, copies };
}

function variant(t: TestContext, name: string) {
  const work = resolve("work");
  mkdirSync(work, { recursive: true });
  const temp = mkdtempSync(join(work, "저장장치시험-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const saved = sceneFile.parse(read(name));
  const models = ["host", "hub", "medium", "one-way"].map(id => modelFile.parse(read(id + "@1")));
  return { saved, host: models[0]!, hub: models[1]!, medium: models[2]!, open() {
    const file = join(temp, "scene.json");
    writeFileSync(file, JSON.stringify(saved));
    for (const m of models) writeFileSync(join(temp, m.modelId + "@1.json"), JSON.stringify(m));
    return run(file, temp);
  } };
}

test("T5 같은 허브의 업스트림을 나눠 쓰면 큰 복사 둘이 각각 400 MB/s 내려간다", () => {
  const { copies, scene } = run(join(dir, "shared-hub.json"));
  assert.deepEqual(copies.map(o => [o.id, o.verdict, ...o.metrics]), [
    ["copy-a", "ok", 100, 100, 0, 0], ["copy-b", "conditional", 800, 400, 400, 50], ["copy-c", "conditional", 800, 400, 400, 50],
  ]);
  const trunk = scene.resources.findIndex(r => r.id === "uplink" && scene.items[r.item]!.id === "hub");
  assert.ok(trunk >= 0);
  for (const copy of copies.slice(1)) {
    assert.deepEqual(copy.bindings.map(b => [b.resourceKind, b.resource]), [["scene", trunk]]);
    assert.deepEqual(new Set(copy.proof.map(r => r.stage)), new Set(["judge", "path", "negotiate", "physical", "allocate"]));
    const involved = copy.proof.find(r => r.stage === "allocate" && r.targetKind === "resource" && r.targetRow === trunk)!;
    assert.ok(involved.claims.some(c => c.field === "capacity" && c.value === 900 && c.sources.includes("fixture:storage-hub")));
    assert.ok(involved.claims.some(c => c.field === "policy" && c.value === "max-min" && c.sources.includes("fixture:storage-hub")));
    assert.ok(copy.proof.some(r => r.stage === "path" && r.claims.some(c => c.field === "throughput" && c.value === 100 && c.sources.includes("fixture:storage-scene"))));
  }
});

test("T6 같은 장치와 요청을 독립 컨트롤러에 연결하면 동시 복사 성능이 유지된다", () => {
  const { sceneId: _t5, connections: _shared, ...shared } = sceneFile.parse(read("shared-hub"));
  const { sceneId: _t6, connections: _separate, ...separate } = sceneFile.parse(read("independent-controllers"));
  assert.deepEqual(separate, shared);
  const { copies, scene } = run(join(dir, "independent-controllers.json"));
  assert.deepEqual(copies.map(o => [o.id, o.verdict, ...o.metrics]), [
    ["copy-a", "ok", 100, 100, 0, 0], ["copy-b", "ok", 800, 800, 0, 0], ["copy-c", "ok", 800, 800, 0, 0],
  ]);
  for (const [i, copy] of copies.entries()) {
    const controller = scene.resources.findIndex(r => r.id === ["bus-a", "bus-b", "bus-c"][i]);
    assert.ok(controller >= 0);
    const controllers = copy.proof.filter(r => r.stage === "allocate" &&
      r.claims.some(c => c.field === "capacity" && c.sources.includes("fixture:storage-host")));
    assert.deepEqual(controllers.map(r => r.targetRow), [controller]);
    assert.ok(copy.proof.some(r => r.stage === "negotiate" &&
      r.claims.some(c => c.field === "throughput" && c.sources.includes("fixture:storage-medium"))));
  }
});

test("T5 호스트 경유 복사가 양방향 합산 업스트림을 두 번 쓰고 방향별 독립이면 한 번씩 쓴다", t => {
  const f = variant(t, "host-copy");
  const shared = f.open();
  const copy = shared.copies[0]!;
  assert.deepEqual([copy.verdict, ...copy.metrics], ["conditional", 450, 450, 0, 0]);
  const picked = shared.result.outcomes[copy.outcome]!.path;
  const edges = shared.result.steps.filter(s => s.path === picked && s.kind === "edge").map(s => shared.scene.edges[s.row]!.id);
  assert.deepEqual(edges, ["read-data", "to-host", "from-host", "write-data"]);
  const usage = copy.proof.filter(r => r.stage === "allocate" && r.claims.some(c => c.field === "use:uplink" && c.sources.includes("fixture:storage-hub")));
  assert.equal(usage.length, 2);
  assert.equal(usage[0]!.targetRow, usage[1]!.targetRow);
  assert.deepEqual(copy.bindings.map(b => b.resource), [usage[0]!.targetRow]);
  assert.ok(copy.proof.some(r => r.stage === "path" && r.claims.some(c => c.field === "viaNode" && c.value === "copy-service" && c.sources.includes("fixture:storage-scene"))));

  f.hub.resources.push({ ...f.hub.resources[0]!, id: "downlink" });
  f.hub.edges.find(e => e.id === "from-host")!.uses[0]!.resource = "downlink";
  const split = f.open();
  assert.deepEqual([split.copies[0]!.verdict, ...split.copies[0]!.metrics], ["ok", 900, 900, 0, 0]);
  const ids = split.copies[0]!.bindings.map(b => split.scene.resources[b.resource]!.id);
  assert.ok(ids.includes("uplink") && ids.includes("downlink"));
  assert.ok(split.copies[0]!.proof.some(r => r.stage === "allocate" && r.claims.some(c => c.field === "use:downlink" && c.sources.includes("fixture:storage-hub"))));
});

test("T5 변환 부품이 복사의 역방향을 막으면 그 부품의 포트 방향과 출처를 남긴다", t => {
  const f = variant(t, "host-copy");
  f.saved.items.push({ ...f.saved.items[0]!, instanceId: "part", modelId: "one-way" });
  f.saved.connections.find(c => c.id === "wire-b")!.parts.push({ instanceId: "part", entry: "entry", exit: "exit" });
  const { scene, result, copies: [copy] } = f.open();
  assert.deepEqual([copy!.verdict, ...copy!.metrics], ["impossible", 0, 0, 0, null]);
  assert.ok(result.needs.some(n => n.outcome === copy!.outcome && n.requiredCapability === "exit → entry 방향의 변환"));
  const proof = copy!.proof.filter(r => r.stage === "physical" && r.rule === "부품의 변환 방향");
  const ports = proof.filter(r => r.targetKind === "port").map(r => scene.ports[r.targetRow]!);
  assert.deepEqual(ports.map(p => [scene.items[p.item]!.id, p.id]).sort(), [["part", "entry"], ["part", "exit"]]);
  assert.ok(proof.some(r => r.claims.some(c => c.field === "edge" && c.sources.includes("fixture:storage-one-way"))));
  const wire = scene.connections.findIndex(c => c.id === "wire-b");
  assert.deepEqual(result.outcomes.filter(o => o.subjectKind === "connection" && o.subjectRow === wire).map(o => [o.direction, o.verdict]),
    [["forward", "ok"], ["reverse", "impossible"]]);
});

test("T5 매체 읽기 한도가 미확인이면 해당 매체와 허브를 공유하는 복사의 동시 성능이 미확인이다", t => {
  const f = variant(t, "shared-hub");
  f.saved.personal[0]!.claim.value = null;
  const { scene, copies } = f.open();
  assert.deepEqual(copies.map(o => [o.verdict, ...o.metrics]), [
    ["unknown", null, null, null, null], ["unknown", 800, null, null, null], ["unknown", 800, null, null, null],
  ]);
  const medium = scene.resources.findIndex(r => r.id === "read-rate" && scene.items[r.item]!.id === "ssd-a");
  assert.ok(medium >= 0);
  for (const copy of copies) {
    assert.ok(copy.proof.some(r => r.stage === "allocate" && r.targetKind === "resource" && r.targetRow === medium &&
      r.claims.some(c => c.field === "capacity" && c.value === null && c.sources.includes("fixture:storage-scene"))));
  }
});

test("T5 요청이 매체·포트 한도를 넘으면 낮은 한도가 병목이다", t => {
  const f = variant(t, "independent-controllers");
  f.saved.scenarios[0]!.members = ["copy-a"];
  f.saved.workloads[0]!.request.throughput!.value = 200;
  const mediaBound = f.open();
  assert.deepEqual([mediaBound.copies[0]!.verdict, ...mediaBound.copies[0]!.metrics], ["conditional", 100, 100, 0, 0]);
  const readRate = mediaBound.copies[0]!.bindings[0]!;
  assert.equal(mediaBound.scene.resources[readRate.resource]?.id, "read-rate");
  assert.ok(mediaBound.copies[0]!.proof.some(r => r.stage === "allocate" && r.targetRow === readRate.resource &&
    r.claims.some(c => c.field === "capacity" && c.value === 100 && c.sources.includes("fixture:storage-scene"))));

  f.host.ports.find(p => p.id === "a")!.interfaces[0]!.params.throughput!.value = 50;
  const linkBound = f.open().copies[0]!;
  assert.deepEqual([linkBound.verdict, ...linkBound.metrics], ["conditional", 50, 50, 0, 0]);
  assert.deepEqual(linkBound.bindings.map(b => b.resourceKind), ["link"]);
  assert.ok(linkBound.proof.some(r => r.stage === "negotiate" && r.claims.some(c => c.field === "throughput" && c.value === 50 && c.sources.includes("fixture:storage-host"))));
});

test("T5 읽기 경로의 상시 발열 한도는 적용하고 온도 조건이 붙은 값은 근거 계산에서 제외한다", t => {
  const f = variant(t, "independent-controllers");
  f.saved.scenarios[0]!.members = ["copy-a"];
  const readRate = f.medium.resources[0]!;
  f.medium.resources.push({ ...readRate, id: "thermal-rate", kind: "thermal", capacity: { ...readRate.capacity, value: 60 } });
  const use = f.medium.edges[0]!.uses[0]!;
  f.medium.edges[0]!.uses.push({ ...use, resource: "thermal-rate" });
  const measured = f.saved.personal[0]!;
  f.saved.personal.push({ ...measured, ownerId: "thermal-rate", claim: { ...measured.claim, value: 30, condition: "고온" } });

  const { scene, copies: [copy] } = f.open();
  assert.deepEqual([copy!.verdict, ...copy!.metrics], ["conditional", 60, 60, 0, 0]);
  const thermal = copy!.bindings[0]!.resource;
  assert.equal(scene.resources[thermal]!.id, "thermal-rate");
  const reason = copy!.proof.find(r => r.stage === "allocate" && r.targetKind === "resource" && r.targetRow === thermal)!;
  assert.deepEqual(reason.claims.filter(c => c.field === "capacity").map(c => [c.value, c.sources]), [[60, ["fixture:storage-medium"]]]);
});

test("T5 지정한 복사 경유 노드를 확인할 수 없으면 확보한 처리량을 확정하지 않는다", t => {
  const f = variant(t, "host-copy");
  const via = f.saved.workloads[0]!.request.viaNode!;
  via.value = null;
  via.confidence = "unknown";
  const { copies: [copy] } = f.open();
  assert.deepEqual([copy!.verdict, ...copy!.metrics], ["unknown", null, null, null, null]);
  assert.ok(copy!.proof.some(r => r.stage === "path" && r.rule === "복사 경유 노드 미확인" &&
    r.claims.some(c => c.field === "viaNode" && c.value === null && c.sources.includes("fixture:storage-scene"))));
});

test("T5 영역과 단위가 다른 매체 자원은 모델 필드에서 거절한다", t => {
  const f = variant(t, "independent-controllers");
  f.saved.personal = [];
  const medium = f.medium.resources[0]!;
  medium.unit = medium.capacity.unit = "GB/s";
  medium.capacity.value = 0.1;
  assert.throws(() => f.open(), /medium@1.json#resources.0.unit/);
});

test("T5 복사 포트 한도가 50과 미확인이면 100 요청의 범위는 0–50이다", t => {
  const f = variant(t, "shared-hub");
  f.hub.ports.find(p => p.id === "a")!.interfaces[0]!.params.throughput!.value = 50;
  f.medium.ports[0]!.interfaces[0]!.params.throughput!.value = null;
  const { copies, result, scene } = f.open(), a = copies.find(c => c.id === "copy-a")!;
  for (const kind of ["solo", "together"]) {
    const m = result.metrics.find(m => m.outcome === a.outcome && m.kind === kind)!;
    assert.deepEqual([m.low, m.high, m.value], [0, 50, null]);
  }
  assert.deepEqual(result.possibleVerdicts.filter(p => p.outcome === a.outcome).map(p => p.verdict).sort(), ["conditional", "impossible"]);
  assert.ok(result.quests.some(q => q.outcome === a.outcome && scene.claims[q.claim]!.field === "throughput"));
  assert.ok(a.proof.some(r => r.claims.some(c => c.value === 50 && c.sources.includes("fixture:storage-hub"))));
});
