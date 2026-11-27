// 합성 T7 장면의 협상, LAN·WAN 배분, PoE 전력과 판정 근거를 로더부터 확인한다.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { loadScene } from "../../cli/load.ts";
import { network } from "../../domains/network/network.ts";
import { effectiveClaim, type Scene, type Value } from "../../engine/contract.ts";
import { evaluate } from "../../engine/evaluate.ts";

const expectedGigabit = 1_000 * 1_500 / 1_538;
function load() {
  return loadScene(join(import.meta.dirname, "scene.json"), {
    modelsDir: import.meta.dirname, connectorsFile: join(import.meta.dirname, "connectors.json"),
  }, [network]);
}

function claim(scene: Scene, kind: "item" | "interface" | "resource", itemId: string, ownerId: string, field: string) {
  const item = scene.items.findIndex(i => i.id === itemId);
  const owner = kind === "item" ? item : kind === "interface"
    ? scene.interfaces.findIndex(i => i.id === ownerId && scene.ports[i.port]!.item === item)
    : scene.resources.findIndex(r => r.id === ownerId && r.item === item);
  const row = effectiveClaim(scene, kind, owner, "network", field);
  assert.ok(row !== undefined, `${itemId}.${ownerId}.${field}`);
  return row;
}

function setClaim(scene: Scene, kind: Parameters<typeof claim>[1], itemId: string, ownerId: string, field: string, value: Value) {
  const row = claim(scene, kind, itemId, ownerId, field);
  scene.claims[row]!.value = value;
  return row;
}

function inspect(scene: Scene, id: string, scenarioId = id, result = evaluate(scene, [network])) {
  assert.deepEqual(result.errors, []);
  const scenario = scene.scenarios.findIndex(s => s.id === scenarioId);
  const workload = scene.workloads.findIndex(w => w.id === id);
  const outcomeIndex = result.outcomes.findIndex(o => o.subjectKind === "workload" && o.subjectRow === workload && o.scenario === scenario);
  assert.ok(outcomeIndex >= 0);
  const outcome = result.outcomes[outcomeIndex]!;
  const path = outcome.path;
  assert.ok(path !== null);
  const reasons = result.reasons.filter(r => r.outcome === outcomeIndex);
  assert.ok(reasons.some(r => r.stage === "physical" && r.rule === "커넥터 결합"));
  assert.ok(reasons.some(r => r.stage === "path") && reasons.some(r => r.stage === "judge"));
  const claims = result.reasonInputs.filter(i => result.reasons[i.reason]!.outcome === outcomeIndex).map(i => i.claim);
  const specs = result.reasonSpecs.filter(s => result.reasons[s.reason]!.outcome === outcomeIndex).map(s => result.specSources[s.source]!.id);
  const metrics = result.metrics.filter(m => m.outcome === outcomeIndex);
  const bindings = result.bindings.filter(b => b.scenario === scenario && b.workload === workload && b.run === "together");
  const options = result.steps.flatMap(s => s.path === path && s.option !== null ? [result.options[s.option]!] : []);
  const quests = result.quests.filter(q => q.outcome === outcomeIndex);
  const possible = result.possibleVerdicts.filter(p => p.outcome === outcomeIndex).map(p => p.verdict).sort();
  return { outcome, reasons, claims, specs, options, quests, possible,
    value: metrics.find(m => m.kind === "together")!.value, solo: metrics.find(m => m.kind === "solo")!.value,
    drop: metrics.find(m => m.kind === "drop")!.value, unused: metrics.find(m => m.kind === "unused"),
    resources: bindings.flatMap(b => b.resourceKind === "scene" ? [scene.resources[b.resource]!.id] : []),
  };
}

test("T7 2.5GbE NIC와 Cat5e 30 m에서 1G를 협상하고 회선까지 MAC 페이로드 효율을 한 번만 반영한다", () => {
  const scene = load(), result = evaluate(scene, [network]);
  const usable = inspect(scene, "internet-900", "internet-900", result);
  const limited = inspect(scene, "internet-1000", "internet-1000", result);
  assert.deepEqual([usable.outcome.verdict, usable.value], ["ok", 900]);
  assert.equal(limited.outcome.verdict, "conditional");
  assert.ok(Math.abs(limited.value! - expectedGigabit) < 1e-9);
  assert.equal(Number(limited.value!.toFixed(3)), 975.293);
  assert.ok(limited.resources.includes("line"));
  assert.equal(limited.options.length, 2);
  for (const option of limited.options) {
    assert.equal(option.limit, expectedGigabit);
    assert.match(option.rule, /1000BASE-T.*회선 1000 Mbps.*Cat5e.*30 m/);
  }
  assert.ok(usable.reasons.some(r => r.stage === "negotiate" && r.rule.includes("미사용 회선 성능 1500 Mbps")));
  assert.equal(usable.unused?.unit, "Mbps");
  assert.ok(Math.abs(usable.unused!.value! - 1.5 * expectedGigabit) < 1e-9);
  for (const field of ["category", "length"]) {
    const input = claim(scene, "item", "lan-a-wire", "", field);
    assert.ok(limited.claims.includes(input));
    assert.equal(scene.sources[scene.claimSources.find(c => c.claim === input)!.source]!.id, "network-copper");
  }
  assert.ok(["base-t", "copper-reach", "mac-framing"].every(spec => limited.specs.includes(spec)));
});

test("Cat5e의 2.5G·5G와 55 m 초과 Cat6의 10G에는 채널 확인 조건이 붙는다", () => {
  const scene = load();
  for (const mode of ["2.5GBASE-T", "5GBASE-T", "10GBASE-T"]) {
    setClaim(scene, "interface", "host-a", "lan", "baseTModes", mode);
    setClaim(scene, "interface", "router", "lan-a", "baseTModes", mode);
    if (mode === "10GBASE-T") {
      setClaim(scene, "item", "lan-a-wire", "", "category", "Cat6");
      setClaim(scene, "item", "lan-a-wire", "", "length", 70);
      setClaim(scene, "item", "lan-a-wire", "", "screening", "screened");
    }
    const r = inspect(scene, "first-hop");
    assert.equal(r.outcome.verdict, "conditional", mode);
    assert.equal(r.value, 900);
    assert.ok(r.reasons.some(reason => reason.stage === "negotiate" && reason.rule.includes(mode) && reason.rule.includes("외래 누화")));
    assert.ok(r.specs.includes("copper-reach"));
    if (mode === "10GBASE-T") assert.ok(r.specs.includes("cat6-10g-reach"));
  }
  setClaim(scene, "item", "lan-a-wire", "", "screening", "unscreened");
  const mitigated = inspect(scene, "first-hop");
  assert.equal(mitigated.outcome.verdict, "conditional");
  assert.ok(mitigated.reasons.some(reason => reason.rule.includes("완화")));
  setClaim(scene, "item", "lan-a-wire", "", "length", 101);
  const r = inspect(scene, "first-hop");
  assert.equal(r.outcome.verdict, "impossible");
  assert.ok(r.reasons.some(reason => reason.rule.includes("도달 거리 조건")));
});

test("길이 미확인은 공통 모드의 상한과 케이블 길이 퀘스트를 남긴다", () => {
  const scene = load();
  const length = setClaim(scene, "item", "lan-a-wire", "", "length", null);
  const pending = inspect(scene, "first-hop");
  assert.equal(pending.outcome.verdict, "unknown");
  assert.deepEqual(pending.options[0]!.bounds, { low: 0, high: expectedGigabit });
  assert.ok(pending.quests.some(q => q.claim === length && q.instruction === network.quest("length")));
  assert.ok(pending.specs.includes("copper-reach"));
  assert.ok(pending.possible.includes("impossible") && pending.possible.includes("ok"));
  setClaim(scene, "item", "lan-a-wire", "", "length", 101);
  assert.equal(inspect(scene, "first-hop").outcome.verdict, "impossible");
});

test("공통 BASE-T 모드가 없거나 LAN 단말을 WAN 포트에 결합하면 해당 주장을 근거로 거절한다", () => {
  const scene = load();
  const mode = setClaim(scene, "interface", "router", "lan-a", "baseTModes", "100BASE-TX");
  const noCommon = inspect(scene, "first-hop");
  assert.equal(noCommon.outcome.verdict, "impossible");
  assert.ok(noCommon.reasons.some(r => r.rule.includes("공통 BASE-T 모드 없음")));
  assert.ok(noCommon.claims.includes(mode) && noCommon.specs.includes("base-t"));
  setClaim(scene, "interface", "router", "lan-a", "baseTModes", "1000BASE-T");
  const role = setClaim(scene, "interface", "router", "lan-a", "networkRole", "wan");
  const wrongPort = inspect(scene, "first-hop");
  assert.equal(wrongPort.outcome.verdict, "impossible");
  assert.ok(wrongPort.reasons.some(r => r.rule.includes("포트 역할 lan ↔ wan 결합 불가")));
  assert.ok(wrongPort.claims.includes(role) && wrongPort.claims.includes(claim(scene, "interface", "host-a", "lan", "networkRole")));
  assert.ok(scene.claimSources.some(s => s.claim === role));
});

test("LAN 전송 두 개가 백플레인과 업링크를 공유하고 제한하는 자원에 하락을 귀속한다", () => {
  const scene = load();
  for (const [bottleneck, together] of [["uplink", 600], ["backplane", 500]] as const) {
    const result = evaluate(scene, [network]);
    for (const id of ["lan-a", "lan-b"]) {
      const r = inspect(scene, id, "shared-lan", result);
      assert.deepEqual([r.outcome.verdict, r.solo, r.value, r.drop], ["conditional", 900, together, 900 - together]);
      assert.deepEqual(r.resources, [bottleneck]);
      assert.ok(r.reasons.some(reason => reason.stage === "allocate" && reason.targetKind === "resource" && scene.resources[reason.targetRow]!.id === bottleneck));
      assert.ok(["backplane", "uplink"].every(resource => r.claims.includes(claim(scene, "resource", "router", resource, "capacity"))));
    }
    setClaim(scene, "resource", "router", "backplane", "capacity", 1_000);
  }
});

test("회선 병목은 WAN 전송에만 적용되고 LAN 전송은 회선 주장에 의존하지 않는다", () => {
  const scene = load();
  const capacity = setClaim(scene, "resource", "access", "line", "capacity", 500);
  const result = evaluate(scene, [network]);
  const lan = inspect(scene, "lan-a", "lan-a", result);
  const wan = inspect(scene, "internet-900", "internet-900", result);
  assert.deepEqual([lan.outcome.verdict, lan.value], ["ok", 900]);
  assert.equal(lan.claims.includes(capacity), false);
  assert.equal(wan.outcome.verdict, "conditional");
  assert.ok(Math.abs(wan.value! - expectedGigabit / 2) < 1e-9);
  assert.deepEqual(wan.resources, ["line"]);
  assert.ok(wan.claims.includes(capacity) && wan.specs.includes("mac-framing"));
});

test("PoE Type 2는 송전 포트 예산과 채널 손실을 적용해 고정 수전 요청을 판정한다", () => {
  const scene = load(), result = evaluate(scene, [network]);
  const allowed = inspect(scene, "poe-12", "poe-12", result), overloaded = inspect(scene, "poe-14", "poe-14", result);
  assert.deepEqual([allowed.outcome.verdict, allowed.value, allowed.options[0]!.limit], ["ok", 12, 13]);
  assert.deepEqual([overloaded.outcome.verdict, overloaded.value], ["impossible", 0]);
  assert.equal(allowed.options[0]!.unit, "W");
  assert.ok(allowed.reasons.some(r => r.stage === "allocate" && r.targetKind === "resource" && scene.resources[r.targetRow]!.id === "port-budget"));
  assert.ok(overloaded.reasons.some(r => r.stage === "negotiate" && /Type 2.*25.5 W.*포트 예산 15 W.*채널 손실 예약 2 W.*수전 한도 13 W/.test(r.rule)));
  for (const r of [allowed, overloaded]) {
    assert.ok(r.claims.includes(claim(scene, "resource", "pse", "port-budget", "capacity")));
    assert.ok(r.claims.includes(claim(scene, "item", "poe-wire", "", "poeLoss")));
    assert.ok(r.specs.includes("poe-type"));
  }
  const data = inspect(scene, "poe-ethernet", "poe-ethernet", result);
  assert.deepEqual([data.outcome.verdict, data.value, data.options[0]!.unit], ["ok", 900, "Mbps"]);
  const reverse = inspect(scene, "poe-reverse", "poe-reverse", result);
  assert.equal(reverse.outcome.verdict, "impossible");
  assert.ok(reverse.reasons.some(r => r.rule.includes("송전 포트 → 수전 포트 방향")));
});

test("PoE는 규격 상한을 넘는 송전 예산을 제한하고 미확인 채널 손실은 퀘스트로 보낸다", () => {
  const scene = load();
  setClaim(scene, "resource", "pse", "port-budget", "capacity", 100);
  const capped = inspect(scene, "poe-14");
  assert.deepEqual([capped.outcome.verdict, capped.options[0]!.limit], ["ok", 25.5]);
  setClaim(scene, "resource", "pse", "port-budget", "capacity", 15);
  const loss = setClaim(scene, "item", "poe-wire", "", "poeLoss", null);
  const pending = inspect(scene, "poe-12");
  assert.equal(pending.outcome.verdict, "unknown");
  assert.deepEqual(pending.options[0]!.bounds, { low: 0, high: 15 });
  assert.ok(pending.quests.some(q => q.claim === loss && q.instruction === network.quest("poeLoss")));
  assert.ok(pending.specs.includes("poe-type"));
});
