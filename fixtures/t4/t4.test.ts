// USB4 독의 실제 영상·벌크·PCIe·이더넷 경로와 공용 자원 배분을 검증한다.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { plugins } from "../../cli/domains.ts";
import { loadScene } from "../../cli/load.ts";
import { display } from "../../domains/display/display.ts";
import { effectiveClaim, type Scene } from "../../engine/contract.ts";
import { evaluate, evaluateVariants } from "../../engine/evaluate.ts";

function fixture(name: string) {
  const dir = import.meta.dirname;
  return loadScene(join(dir, name + ".json"), { modelsDir: dir, connectorsFile: join(dir, "connectors.json") }, plugins);
}

function inspect(scene: Scene, result = evaluate(scene, plugins)) {
  assert.deepEqual(result.errors, []);
  function work(scenario: string, id: string) {
    const workload = scene.workloads.findIndex(w => w.id === id);
    const scenarioRow = scene.scenarios.findIndex(s => s.id === scenario);
    const row = result.outcomes.findIndex(o => o.subjectKind === "workload" && o.scenario === scenarioRow && o.subjectRow === workload);
    const outcome = result.outcomes[row]!;
    assert.ok(outcome.path !== null);
    const steps = result.steps.filter(s => s.path === outcome.path);
    const links = steps.flatMap(s => s.kind === "connection" && s.option !== null ? [{
      name: scene.connections[s.row]!.id, direction: s.direction, carrier: s.carrier, row: s.option, option: result.options[s.option]!,
    }] : []);
    const reasons = result.reasons.filter(r => r.outcome === row);
    const stages = ["physical", "negotiate", "path", "judge"];
    if (result.paths[outcome.path]!.verdict !== "impossible") stages.push("allocate");
    for (const stage of stages)
      assert.ok(reasons.some(r => r.stage === stage), id + " · " + stage);
    const inputs = result.reasonInputs.filter(r => result.reasons[r.reason]!.outcome === row).map(r => r.claim);
    const specs = result.reasonSpecs.filter(r => result.reasons[r.reason]!.outcome === row).map(r => result.specSources[r.source]!.id);
    const together = result.metrics.find(m => m.outcome === row && m.kind === "together")!;
    const solo = result.metrics.find(m => m.outcome === row && m.kind === "solo")!;
    const demand = result.paths[outcome.path]!.demand;
    return { row, workload, scenarioRow, outcome, steps, links, reasons, inputs, specs, together, solo, demand };
  }
  function cited(inputs: number[], field: string, value: unknown, locator: string) {
    return inputs.some(row => {
      const c = scene.claims[row]!;
      return c.field === field && c.value === value && scene.claimSources.some(s =>
        s.claim === row && scene.sources[s.source]!.locator === locator);
    });
  }
  return { result, work, cited };
}

test("T4 호스트에서 독을 거쳐 영상과 SSD에 도달하고 NIC의 PCIe·이더넷 구간을 각각 판정한다", () => {
  const { work, cited } = inspect(fixture("scene"));
  const expected = [
    ["video-a", 16, "Gbps", ["usb4-upstream", "monitor-a"], "display"],
    ["ssd-write", 800, "MB/s", ["usb4-upstream", "storage"], "data"],
    ["nic-pcie", 100, "MB/s", ["usb4-upstream"], "data"],
    ["ethernet", 800, "Mbps", ["ethernet"], "network"],
  ] as const;
  for (const [id, value, unit, connections, carrier] of expected) {
    const w = work("one-video", id);
    assert.deepEqual([w.outcome.verdict, w.together.value, w.together.unit], ["ok", value, unit]);
    assert.deepEqual(w.links.map(s => s.name), connections);
    assert.ok(w.links.every(s => s.carrier?.domain === carrier));
  }
  const video = work("one-video", "video-a");
  assert.ok(video.specs.includes("dp-tunnel") && video.specs.includes("usb4-tunnels"));
  assert.ok(cited(video.inputs, "tunnelGbps", 28, "fixture:t4/host"));
  assert.ok(cited(video.inputs, "tunnelGbps", 28, "fixture:t4/dock"));
  assert.ok(cited(video.inputs, "cableDataGbps", 40, "fixture:t4/usb4-cable"));

  const ssd = work("one-video", "ssd-write");
  assert.ok(ssd.specs.includes("usb3-estimate") && ssd.specs.includes("usb4-tunnels"));
  assert.ok(cited(ssd.inputs, "capacity", 2000, "fixture:t4/ssd"));

  const pcie = work("one-video", "nic-pcie");
  assert.equal(pcie.links[0]!.carrier?.mode, "pcie-tunnel");
  assert.ok(pcie.reasons.some(r => r.stage === "negotiate" && r.rule.includes("PCIe 터널")));
  assert.ok(pcie.specs.includes("usb4-tunnels") && cited(pcie.inputs, "pcie", true, "fixture:t4/dock"));

  const ethernet = work("one-video", "ethernet");
  assert.ok(ethernet.specs.includes("base-t") && ethernet.specs.includes("mac-framing"));
  assert.ok(cited(ethernet.inputs, "category", "Cat5e", "fixture:t4/lan-wire"));
});

test("T4 동시 모드 선택이 B만 DSC로 바꿔 같은 방향 SSD와 NIC에 400·100 MB/s를 남긴다", () => {
  const scene = fixture("scene");
  const { result, work, cited } = inspect(scene);
  const a = work("two-video", "video-a"), b = work("two-video", "video-b");
  const ssd = work("two-video", "ssd-write"), nic = work("two-video", "nic-pcie");
  const receive = work("two-video", "nic-reverse");
  assert.deepEqual([a.outcome.verdict, a.together.value, a.together.unit], ["ok", 16, "Gbps"]);
  assert.deepEqual([b.outcome.verdict, b.outcome.mode, b.together.value, b.together.unit], ["conditional", "dsc", 8, "Gbps"]);
  assert.deepEqual(b.links.map(l => l.name), ["usb4-upstream", "monitor-b"]);
  assert.equal(b.links[1]!.option.limit, 25.92);
  assert.equal(b.solo.value, 16);
  const soloPath = result.paths[b.outcome.soloPath!]!;
  const soloDemand = result.demands[soloPath.demand]!;
  assert.deepEqual([soloDemand.mode, soloDemand.requested], ["uncompressed:subsampled", 16]);
  assert.ok(cited(b.inputs, "lanes", 4, "fixture:t4/dock"));
  assert.ok(result.searches.some(s => s.scenario === b.scenarioRow && s.examined >= 2 && !s.truncated));
  assert.ok(b.specs.includes("dsc") && b.specs.includes("dp-tunnel"));
  for (const l of b.links) {
    const match = result.matches.find(m => m.demand === b.demand && m.option === l.row)!;
    assert.equal(match.verdict, "conditional");
    assert.match(match.rule, /DSC 8 bpp/u);
    assert.ok(cited(match.inputs, "dscBpp", 8, "fixture:t4/scene"));
    const codecOwners = match.inputs.filter(row => scene.claims[row]!.ownerKind === "interface");
    assert.equal(codecOwners.length, 2);
    assert.ok(codecOwners.every(row => b.inputs.includes(row)));
  }

  assert.deepEqual([ssd.outcome.verdict, ssd.solo.value, ssd.together.unit], ["conditional", 800, "MB/s"]);
  assert.ok(Math.abs(ssd.together.value! - 400) < 1e-9);
  assert.deepEqual([nic.outcome.verdict, nic.together.value, nic.together.unit], ["ok", 100, "MB/s"]);
  const forward = a.links[0]!.option.poolResource!;
  const reverse = receive.links[0]!.option.poolResource!;
  assert.notEqual(forward, reverse);
  assert.deepEqual([forward, reverse].map(row => {
    const r = result.linkResources[row]!;
    return [r.direction, r.pool!.id, r.pool!.scope, r.pool!.limit, r.pool!.unit];
  }), [["forward", "usb4-tunnel", "direction", 28, "Gbps"], ["reverse", "usb4-tunnel", "direction", 28, "Gbps"]]);
  let usedGbps = 0;
  for (const [w, perUnit] of [[a, 1], [b, 1], [ssd, 0.008], [nic, 0.008]] as const) {
    const o = w.links[0]!.option;
    assert.equal(o.poolResource, forward);
    assert.equal(o.pool?.perUnit, perUnit);
    usedGbps += w.together.value! * perUnit;
    assert.ok(w.reasons.some(r => r.stage === "allocate" && r.targetKind === "linkResource" && r.targetRow === forward));
    assert.ok(w.specs.includes("usb4-tunnels") && cited(w.inputs, "tunnelGbps", 28, "fixture:t4/dock"));
  }
  assert.ok(Math.abs(usedGbps - 28) < 1e-9);
  assert.ok(result.bindings.some(b => b.scenario === ssd.scenarioRow && b.workload === ssd.workload &&
    b.run === "together" && b.resourceKind === "link" && b.resource === forward));
  assert.deepEqual([receive.outcome.verdict, receive.together.value], ["ok", 100]);
  const ethernet = work("two-video", "ethernet");
  assert.deepEqual([ethernet.outcome.verdict, ethernet.together.value, ethernet.together.unit], ["ok", 800, "Mbps"]);
});

test("T4 USB4 미지원 업스트림 케이블은 두 영상의 DP 터널을 막고 케이블 주장을 근거에 남긴다", () => {
  const scene = fixture("scene");
  const upstream = scene.items.findIndex(i => i.id === "upstream");
  const cable = effectiveClaim(scene, "item", upstream, "data", "cableUsb4")!;
  scene.claims[cable]!.value = false;

  const { result, work, cited } = inspect(scene);
  for (const id of ["video-a", "video-b"]) {
    const w = work("two-video", id);
    assert.deepEqual([w.outcome.verdict, w.solo.value, w.together.value, w.together.unit], ["impossible", 0, 0, "Gbps"]);
    assert.deepEqual(result.possibleVerdicts.filter(v => v.outcome === w.row).map(v => v.verdict), ["impossible"]);
    const pool = w.links.find(l => l.name === "usb4-upstream")!.option.poolResource;
    assert.ok(w.reasons.some(r => r.stage === "negotiate" && r.targetKind === "linkResource" && r.targetRow === pool));
    assert.ok(cited(w.inputs, "cableUsb4", false, "fixture:t4/usb4-cable"));
    assert.ok(cited(w.inputs, "modes", "Gen 3x2", "fixture:t4/host"));
    assert.ok(cited(w.inputs, "modes", "Gen 3x2", "fixture:t4/dock"));
    assert.ok(w.specs.includes("usb4-link") && w.specs.includes("usb4-tunnels") && w.specs.includes("usb-c-data"));
  }
});

test("T4 업스트림 케이블의 USB4 지원이 미확인이면 두 영상의 가능 범위와 확인 퀘스트를 남긴다", () => {
  const scene = fixture("scene");
  const upstream = scene.items.findIndex(i => i.id === "upstream");
  const cable = effectiveClaim(scene, "item", upstream, "data", "cableUsb4")!;
  scene.claims[cable]!.value = null;
  scene.claims[cable]!.confidence = "unknown";

  const { result, work, cited } = inspect(scene);
  for (const id of ["video-a", "video-b"]) {
    const w = work("two-video", id);
    assert.equal(w.outcome.verdict, "unknown");
    for (const metric of [w.solo, w.together]) assert.deepEqual([metric.value, metric.low, metric.high, metric.unit], [null, 0, 16, "Gbps"]);
    assert.deepEqual(result.possibleVerdicts.filter(v => v.outcome === w.row).map(v => v.verdict).sort(), ["impossible", "ok"]);
    const pool = w.links.find(l => l.name === "usb4-upstream")!.option.poolResource!;
    assert.deepEqual(result.linkResources[pool]!.pool!.bounds, { low: 0, high: 28 });
    assert.ok(cited(w.inputs, "cableUsb4", null, "fixture:t4/usb4-cable"));
    assert.ok(result.quests.some(q => q.outcome === w.row && q.claim === cable && q.instruction.includes("USB4")));
  }
});

test("T4 스트림 예산 한 자리로는 두 영상의 동시 예약을 만족시킬 수 없다", () => {
  const scene = fixture("scene");
  const resource = scene.resources.findIndex(r => scene.items[r.item]!.id === "dock" && r.id === "streams");
  const capacity = effectiveClaim(scene, "resource", resource, "display", "capacity")!;
  scene.claims[capacity]!.value = 1;
  const variants = evaluateVariants(scene, plugins, 1);
  const { result, work, cited } = inspect(scene, variants[0]!.result);
  const alone = work("one-video", "video-a");
  assert.deepEqual([alone.outcome.verdict, alone.together.value], ["ok", 16]);
  const two = [work("two-video", "video-a"), work("two-video", "video-b")];
  assert.deepEqual(two.map(w => [w.solo.value, w.together.value, w.outcome.verdict]), [[16, null, "unknown"], [16, null, "unknown"]]);
  for (const w of two) {
    const uses = display.consume(scene, w.workload, w.steps, result.demands[w.demand]!, result.options).filter(u => u.resource === resource);
    assert.deepEqual(uses.map(u => [u.fixed, u.coefficient]), [[1, 0]]);
    assert.ok(w.reasons.some(r => r.stage === "allocate" && r.targetKind === "resource" && r.targetRow === resource &&
      r.rule.includes("스트림 한 자리 예약")));
    assert.ok(cited(w.inputs, "capacity", 1, "fixture:t4/dock"));
    assert.ok(w.specs.includes("dp-tunnel"));
  }
  const reservations = variants.slice(1).map(({ result }) => {
    const variant = inspect(scene, result);
    const successful = ["video-a", "video-b"].filter(id => variant.work("two-video", id).together.value === 16);
    assert.equal(successful.length, 1);
    const rejected = successful[0] === "video-a" ? "video-b" : "video-a";
    assert.equal(variant.work("two-video", rejected).outcome.verdict, "impossible");
    assert.deepEqual(result.reservations.filter(r => r.scenario === 1).map(r => scene.workloads[r.workload]!.id), successful);
    return successful[0]!;
  }).sort();
  assert.deepEqual(reservations, ["video-a", "video-b"]);
});
