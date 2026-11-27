// USB 협상과 터널 예산을 합성 Type-C 배선의 작업 판정·근거·출처까지 검증한다.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadScene } from "../../cli/load.ts";
import { data } from "../../domains/data/data.ts";
import { evaluate } from "../../engine/evaluate.ts";

const dir = fileURLToPath(new URL(".", import.meta.url));
const plugins = [data];
function fixture() {
  return loadScene(join(dir, "scene.json"), { modelsDir: dir, connectorsFile: join(dir, "connectors.json") }, plugins);
}

function run(scene = fixture()) {
  const result = evaluate(scene, plugins);
  assert.deepEqual(result.errors, []);
  const work = result.outcomes.flatMap((o, row) => {
    if (o.subjectKind !== "workload") return [];
    const reasons = result.reasons.filter(r => r.outcome === row);
    assert.ok(reasons.some(r => r.stage === "judge"));
    const claims = result.reasonInputs.filter(r => result.reasons[r.reason]!.outcome === row).map(r => {
      const locators = scene.claimSources.filter(s => s.claim === r.claim).map(s => scene.sources[s.source]!.locator);
      assert.ok(locators.length);
      return { ...scene.claims[r.claim]!, locators };
    });
    const specs = result.reasonSpecs.filter(r => result.reasons[r.reason]!.outcome === row).map(r => result.specSources[r.source]!.id);
    const together = result.metrics.find(m => m.outcome === row && m.kind === "together")!;
    assert.equal(together.unit, "MB/s");
    return [{ row, verdict: o.verdict, id: scene.workloads[o.subjectRow]!.id, claims, specs, reasons, together }];
  });
  return { result, work };
}

test("T2 USB 3.2 단말을 USB 2.0 케이블로 연결하면 벌크는 53.248 MB/s로 제한된다", () => {
  const { work: [w] } = run();
  assert.deepEqual([w!.verdict, w!.together.value], ["conditional", 53.248]);
  assert.equal(new Set(w!.claims.filter(c => c.field === "modes" && c.locators.includes("fixture:data-endpoint"))
    .map(c => c.owner)).size, 4);
  assert.ok(w!.claims.some(c => c.field === "cableDataGbps" && c.value === 0.48 && c.locators.includes("fixture:data-cable")));
  assert.ok(w!.specs.includes("usb2-bulk") && w!.specs.includes("usb-c-data"));
  assert.ok(w!.reasons.some(r => r.stage === "negotiate" && r.rule.includes("규격 벌크 페이로드 상한")));
});

test("T2 공통 USB 3.2 모드와 케이블 등급으로 단방향 및 2레인 규격 추정치를 고른다", () => {
  for (const [rating, modes, limit] of [
    [5, "Gen 1x1", 450], [10, "Gen 1x2", 900], [10, "Gen 2x1", 1_100], [20, "Gen 2x2", 2_200],
  ] as const) {
    const scene = fixture();
    for (const c of scene.claims) {
      if (c.field === "cableDataGbps") c.value = rating;
      if (c.field === "modes" && scene.interfaces[c.owner]?.protocol === "USB") c.value = modes;
      if (c.field === "throughput") c.value = limit;
    }
    const { work: [w] } = run(scene);
    assert.deepEqual([w!.verdict, w!.together.value], ["ok", limit]);
    assert.ok(w!.specs.includes("usb3-estimate"));
    assert.ok(w!.reasons.some(r => r.stage === "negotiate" && r.rule.includes(modes) && r.rule.includes("추정 상한(official)")));
  }
});

test("T2 케이블 데이터 등급이 미확인이면 포트로 상한을 제한하고 확인 퀘스트를 낸다", () => {
  const scene = fixture();
  const grade = scene.claims.findIndex(c => c.field === "cableDataGbps");
  scene.claims[grade]!.value = null;
  scene.claims[grade]!.confidence = "unknown";
  scene.claims.find(c => c.field === "throughput")!.value = 3_000;
  const { result, work: [w] } = run(scene);
  assert.deepEqual([w!.verdict, w!.together.low, w!.together.high, w!.together.value], ["conditional", 53.248, 2_200, null]);
  assert.ok(result.quests.some(q => q.outcome === w!.row && q.claim === grade && q.instruction.includes("등급")));
  assert.ok(w!.specs.includes("usb3-estimate"));
  assert.ok(w!.claims.some(c => c.field === "cableDataGbps" && c.locators.includes("fixture:data-cable")));
});

test("T2 양 끝에 같은 10 Gbps 등급이어도 공통 USB 모드가 없으면 불가다", () => {
  const scene = fixture();
  scene.claims.find(c => c.field === "cableDataGbps")!.value = 10;
  const modes = scene.claims.filter(c => c.field === "modes" && scene.interfaces[c.owner]?.protocol === "USB");
  modes[0]!.value = "Gen 1x2";
  modes[1]!.value = "Gen 2x1";
  const { work: [w] } = run(scene);
  assert.deepEqual([w!.verdict, w!.together.value], ["impossible", 0]);
  for (const mode of modes) assert.ok(w!.claims.some(c => c.owner === mode.owner && c.value === mode.value && c.locators.includes("fixture:data-endpoint")));
  assert.ok(w!.specs.includes("usb3-estimate"));
  assert.ok(w!.reasons.some(r => r.stage === "negotiate" && r.rule.includes("함께 쓸 USB 모드 없음")));
});

function addTransfer(scene: ReturnType<typeof fixture>, id: string, kind: string, requested: number, reverse = false) {
  const first = scene.workloads[0]!;
  const work = scene.workloads.push({ ...first, id, kind, from: reverse ? first.to : first.from, to: reverse ? first.from : first.to }) - 1;
  const fact = scene.claims.findIndex(c => c.field === "throughput");
  const claim = scene.claims.push({ ...scene.claims[fact]!, owner: work, value: requested }) - 1;
  const source = scene.claimSources.find(s => s.claim === fact)!.source;
  scene.claimSources.push({ claim, source });
  scene.members.push({ scenario: 0, workload: work });
}

test("T5 USB 2.0 벌크 전송은 두 방향이 53.248 MB/s를 공유한다", () => {
  const scene = fixture();
  scene.claims.find(c => c.field === "throughput")!.value = 40;
  addTransfer(scene, "return", "bulk", 40, true);
  const { result, work } = run(scene);
  assert.deepEqual(work.map(w => [w.verdict, w.together.value]), [["conditional", 26.624], ["conditional", 26.624]]);
  assert.equal(result.linkResources.filter(r => r.pool?.id === "usb2-bulk" && r.pool.scope === "connection").length, 1);
  for (const w of work) assert.ok(w.reasons.some(r => r.stage === "allocate" && r.rule.includes("양방향 공용")));
});

test("T4 USB4 USB3·PCIe가 같은 방향 28 Gbps를 MB/s당 0.008로 소비하고 반대 방향은 독립이다", () => {
  const scene = fixture();
  scene.claims.find(c => c.field === "cableDataGbps")!.value = 40;
  scene.claims.find(c => c.field === "cableUsb4")!.value = true;
  scene.claims.find(c => c.field === "throughput")!.value = 2_000;
  addTransfer(scene, "pcie", "pcie-tunnel", 2_000);
  addTransfer(scene, "return", "bulk", 2_000, true);
  const { work, result } = run(scene);
  assert.deepEqual(work.map(w => [w.id, w.verdict, w.together.value]), [
    ["pcie", "conditional", 1_750], ["return", "ok", 2_000], ["send", "conditional", 1_750],
  ]);
  const pools = result.linkResources.filter(r => r.pool?.id === "usb4-tunnel");
  assert.deepEqual(pools.map(r => [r.direction, r.pool!.scope, r.pool!.unit, r.pool!.limit]), [
    ["forward", "direction", "Gbps", 28], ["reverse", "direction", "Gbps", 28],
  ]);
  assert.equal(result.options.length, 4);
  assert.ok(result.options.every(o => o.pool?.domain === "data" && o.pool.id === "usb4-tunnel" && o.pool.perUnit === 0.008));
  for (const w of work) {
    assert.ok(w.claims.some(c => c.field === "tunnelGbps" && c.value === 28 && c.locators.includes("fixture:data-endpoint")));
    assert.ok(w.claims.some(c => c.field === "cableDataGbps" && c.value === 40 && c.locators.includes("fixture:data-cable")));
    assert.ok(w.specs.includes("usb4-link") && w.specs.includes("usb4-tunnels"));
  }
});

test("T4 USB4 미지원 케이블이나 공통 USB4 모드가 없는 포트는 방향별 터널 예산을 0으로 낸다", () => {
  for (const [allowed, modes] of [[false, "Gen 3x2"], [true, "Gen 2x2"]] as const) {
    const scene = fixture();
    const cable = scene.claims.findIndex(c => c.field === "cableUsb4");
    scene.claims[cable]!.value = allowed;
    scene.claims.find(c => c.field === "cableDataGbps")!.value = 40;
    scene.claims.find(c => c.field === "throughput")!.value = 2_500;
    const ends = scene.claims.flatMap((c, row) => c.ownerKind === "interface" && c.field === "modes" &&
      scene.interfaces[c.owner]!.protocol === "USB4" ? [row] : []);
    scene.claims[ends[0]!]!.value = "Gen 3x2";
    scene.claims[ends[1]!]!.value = modes;

    const { result, work: [w] } = run(scene);
    assert.deepEqual([w!.verdict, w!.together.value], ["conditional", 2_200]);
    const pools = result.linkResources.filter(r => r.pool?.id === "usb4-tunnel");
    assert.deepEqual(pools.map(r => [r.direction, r.pool!.scope, r.pool!.unit, r.pool!.limit]), [
      ["forward", "direction", "Gbps", 0], ["reverse", "direction", "Gbps", 0],
    ]);
    for (const { pool } of pools) {
      assert.equal(pool!.bounds, undefined);
      assert.equal(pool!.inputs.includes(cable), allowed === false);
      for (const input of allowed === false ? [cable, ...ends] : ends) {
        assert.ok(pool!.inputs.includes(input));
        assert.ok(scene.claimSources.some(s => s.claim === input));
      }
      for (const spec of ["usb4-link", "usb4-tunnels", "usb-c-data"]) assert.ok(pool!.specs.includes(spec));
    }
    assert.ok(result.options.every(o => o.pool?.id !== "usb4-tunnel"));
  }
});

test("T4 USB4 가용 터널 예산이 미확인이면 규격과 알려진 상대 예산으로 상한을 제한한다", () => {
  const scene = fixture();
  scene.claims.find(c => c.field === "cableDataGbps")!.value = 40;
  scene.claims.find(c => c.field === "cableUsb4")!.value = true;
  const budget = scene.claims.findIndex(c => c.field === "tunnelGbps");
  scene.claims[budget]!.value = null;
  scene.claims.find(c => c.field === "throughput")!.value = 2_500;
  const { work: [w], result } = run(scene);
  assert.deepEqual([w!.verdict, w!.together.low, w!.together.high], ["unknown", 0, 2_200]);
  assert.ok(result.quests.some(q => q.outcome === w!.row && q.claim === budget && q.instruction.includes("터널 예산")));
  assert.ok(w!.specs.includes("usb4-link"));

  scene.claims.find(c => c.field === "cableDataGbps")!.value = 20;
  scene.claims.find(c => c.field === "cableUsb4")!.value = null;
  assert.ok(run(scene).result.linkResources.filter(r => r.pool?.id === "usb4-tunnel").every(r =>
    r.pool!.bounds?.high === 20 * 64 / 66));
});

test("T4 USB4 통과 여부가 미확인이면 일반 USB 3.2로 연결될 때의 처리량도 가능 범위에 남는다", () => {
  const scene = fixture();
  scene.claims.find(c => c.field === "cableDataGbps")!.value = 40;
  const compatibility = scene.claims.findIndex(c => c.field === "cableUsb4");
  for (const claim of scene.claims) if (claim.field === "tunnelGbps") claim.value = 1;
  scene.claims.find(c => c.field === "throughput")!.value = 2_500;
  const worlds = [true,false].map(value => {
    scene.claims[compatibility]!.value = value;
    return run(scene).work[0]!;
  });
  assert.deepEqual(worlds.map(w => [w.verdict,w.together.value]),[["conditional",125],["conditional",2200]]);
  scene.claims[compatibility]!.value = null;
  const { result, work: [w] } = run(scene);
  assert.deepEqual([w!.verdict,w!.together.low,w!.together.high],[worlds[0]!.verdict,worlds[0]!.together.value,worlds[1]!.together.value]);
  assert.ok(result.quests.some(q => q.outcome === w!.row && q.claim === compatibility));
  assert.ok(w!.specs.includes("usb4-link") && w!.specs.includes("usb3-estimate"));
  const pools = result.linkResources.filter(r => r.pool?.id === "usb4-tunnel");
  assert.deepEqual(pools.map(r => [r.direction, r.pool!.limit, r.pool!.bounds]), [
    ["forward", null, { low: 0, high: 1 }], ["reverse", null, { low: 0, high: 1 }],
  ]);
});

test("T2 USB 모드 저장 스키마는 중복 또는 모르는 모드를 거절하고 명시적 null은 받는다", () => {
  const params = data.paramsFor!("USB")!;
  const input = (value: string | null) => ({ modes: { value, unit: "" } });
  assert.ok(params.safeParse(input(null)).success);
  assert.equal(params.safeParse(input("Gen 1x1, Gen 1x1")).success, false);
  assert.equal(params.safeParse(input("Gen 3x4")).success, false);
});
