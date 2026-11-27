// 한 USB-C 케이블의 고정 Alt Mode에서 실제 영상과 허브 판정·근거를 함께 검증한다.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { printResults } from "../../cli/print.ts";
import { plugins } from "../../domains/registry.ts";
import { loadScene } from "../../cli/load.ts";
import type { Scene } from "../../engine/contract.ts";
import { evaluate, evaluateVariants } from "../../engine/evaluate.ts";

function fixture(name: string) {
  const dir = import.meta.dirname;
  return loadScene(join(dir, name + ".json"), { modelsDir: dir, connectorsFile: join(dir, "connectors.json") }, plugins);
}

function inspect(scene: Scene, result = evaluate(scene, plugins)) {
  assert.deepEqual(result.errors, []);

  function work(id: string) {
    const workload = scene.workloads.findIndex(w => w.id === id);
    const row = result.outcomes.findIndex(o => o.subjectKind === "workload" && o.subjectRow === workload);
    const outcome = result.outcomes[row]!;
    assert.ok(outcome.path !== null);
    const step = result.steps.find(s => s.path === outcome.path && s.kind === "connection");
    assert.ok(step && step.option !== null);
    assert.equal(scene.connections[step.row]!.id, "display-hub");
    const physical = result.physical.filter(p => p.connection === step.row && p.direction === step.direction);
    assert.deepEqual(physical.map(p => [p.kind, p.verdict]), [["mate", "ok"], ["part", "ok"], ["mate", "ok"]]);
    const reasons = result.reasons.filter(r => r.outcome === row);
    for (const stage of ["physical", "negotiate", "path", "allocate", "judge"])
      assert.ok(reasons.some(r => r.stage === stage), id + " · " + stage);
    const inputs = result.reasonInputs.filter(r => result.reasons[r.reason]!.outcome === row).map(r => r.claim);
    const specs = result.reasonSpecs.filter(r => result.reasons[r.reason]!.outcome === row).map(r => result.specSources[r.source]!.id);
    const metric = result.metrics.find(m => m.outcome === row && m.kind === "together")!;
    return { workload, outcome, option: result.options[step.option]!, reasons, inputs, specs, metric };
  }
  function cited(inputs: number[], field: string, value: unknown, locator: string) {
    return inputs.some(row => {
      const c = scene.claims[row]!;
      return c.field === field && c.value === value && scene.claimSources.some(s =>
        s.claim === row && scene.sources[s.source]!.locator === locator);
    });
  }
  return { scene, result, work, cited };
}

test("T2 고정 핀 C의 한 USB-C 케이블에서 4K144 DSC와 USB 2.0 허브 하락을 함께 설명한다", () => {
  const { scene, result, work, cited } = inspect(fixture("four-lanes"));
  const video = work("video"), hub = work("hub");
  assert.equal(scene.connections.length, 1);
  assert.equal(scene.parts.length, 1);
  assert.deepEqual([video.outcome.verdict, video.outcome.mode, video.metric.value, video.metric.unit],
    ["conditional", "dsc", 15.674472, "Gbps"]);
  assert.equal(video.option.limit, 25.92);
  const requested = result.demands.find(d => d.workload === video.workload && d.preference === 0)!;
  assert.ok(Math.abs(requested.requested! - 31.348944) < 1e-9);
  assert.ok(video.reasons.some(r => r.stage === "negotiate" && r.rule.includes("핀 C") && r.rule.includes("HBR3 × 4레인")));
  assert.ok(video.reasons.some(r => r.stage === "path" && r.rule.includes("인코더") && r.rule.includes("DSC 12 bpp")));
  assert.ok(["dp-alt-mode", "dsc", "cvt-rb-v2"].every(id => video.specs.includes(id)));
  for (const owner of ["host", "monitor"]) {
    assert.ok(cited(video.inputs, "pin", "C", "fixture:t2/" + owner));
    assert.ok(cited(video.inputs, "dscBpp", 12, "fixture:t2/" + owner));
  }
  assert.ok(cited(video.inputs, "dscBpp", 12, "fixture:t2/scene"));

  assert.equal(result.demands.find(d => d.workload === hub.workload)!.requested, 400);
  assert.deepEqual([hub.outcome.verdict, hub.metric.value, hub.metric.unit], ["conditional", 40, "MB/s"]);
  assert.equal(hub.option.limit, 53.248);
  assert.equal(hub.option.pool?.id, "usb2-bulk");
  assert.ok(hub.reasons.some(r => r.stage === "negotiate" && r.rule.includes("USB 2.0 High Speed")));
  const bound = result.bindings.find(b => b.workload === hub.workload && b.run === "together" && b.resourceKind === "scene")!;
  assert.equal(scene.resources[bound.resource]!.id, "hub-bulk");
  assert.ok(hub.reasons.some(r => r.stage === "allocate" && r.targetKind === "resource" && r.targetRow === bound.resource));
  assert.ok(cited(hub.inputs, "capacity", 40, "fixture:t2/configuration"));
  assert.ok(cited(hub.inputs, "modes", "High Speed", "fixture:t2/configuration"));
  assert.ok(cited(hub.inputs, "cableDataGbps", 5, "fixture:t2/cable"));
  assert.ok(["usb2-bulk", "usb-c-data"].every(id => hub.specs.includes(id)));
});

test("T2 핀 D를 직접 고정한 장면은 60 Hz 폴백과 USB 3.2 허브 전송을 낸다", () => {
  const { result, work, cited } = inspect(fixture("two-lanes"));
  const video = work("video"), hub = work("hub");
  assert.deepEqual([video.outcome.verdict, video.outcome.mode, video.metric.value],
    ["conditional", "uncompressed", 12.542736]);
  assert.equal(video.option.limit, 12.96);
  const dsc = result.demands.find(d => d.workload === video.workload && d.mode === "dsc")!;
  assert.ok(dsc.requested! > video.option.limit);
  assert.ok(video.reasons.some(r => r.stage === "path" && r.rule.includes("60 Hz 폴백")));
  assert.ok(video.reasons.some(r => r.stage === "negotiate" && r.rule.includes("핀 D") && r.rule.includes("HBR3 × 2레인")));
  assert.ok(video.specs.includes("dp-alt-mode") && cited(video.inputs, "pin", "D", "fixture:t2/configuration"));
  assert.deepEqual([hub.outcome.verdict, hub.metric.value], ["ok", 400]);
  assert.equal(hub.option.limit, 450);
  assert.ok(hub.reasons.some(r => r.stage === "negotiate" && r.rule.includes("USB 3.2 Gen 1x1")));
  assert.ok(hub.specs.includes("usb3-estimate") && cited(hub.inputs, "capacity", 420, "fixture:t2/monitor"));
});


test("T2 지정 영상의 우선순위로 4레인을 기본으로 선택하고 2레인과 USB 전용을 대안으로 낸다", () => {
  const scene = fixture("scene");
  const variants = evaluateVariants(scene, plugins, 0);
  const profiles = variants.map(v => {
    assert.equal(v.choices.length, 1);
    const choice = v.choices[0]!;
    assert.equal(scene.connections[choice.connection]!.id, "display-hub");
    assert.deepEqual(v.result.choices.map(c => [c.scenario, c.connection, c.profile]), [[0, choice.connection, choice.profile]]);
    assert.ok(v.result.searches.every(search => !search.truncated));
    return choice.profile;
  });
  assert.equal(profiles[0], "dp-4lane");
  assert.deepEqual([...profiles].sort(), ["dp-2lane", "dp-4lane", "usb-only"]);
  assert.deepEqual(evaluate(scene, plugins), variants[0]!.result);

  const primary = inspect(scene, variants[0]!.result);
  const video = primary.work("video"), hub = primary.work("hub");
  assert.deepEqual([video.outcome.verdict, video.outcome.mode, video.metric.value, video.option.profile],
    ["conditional", "dsc", 15.674472, "dp-4lane"]);
  assert.deepEqual([hub.outcome.verdict, hub.metric.value, hub.option.profile], ["conditional", 53.248, undefined]);
  assert.equal(hub.option.pool?.id, "usb2-bulk");
  assert.ok(hub.reasons.some(r => r.stage === "negotiate" && r.rule.includes("USB 2.0 High Speed")));
  assert.ok(video.reasons.some(r => r.stage === "path" && r.rule.includes("DSC 12 bpp")));
  assert.ok(video.specs.includes("dp-alt-mode") && video.specs.includes("dsc") && hub.specs.includes("usb2-bulk"));
  assert.ok(primary.cited(video.inputs, "pin", "C", "fixture:t2/host"));
  assert.ok(primary.cited(hub.inputs, "cableDataGbps", 5, "fixture:t2/cable"));
  const priority = scene.members.find(m => m.workload === video.workload)!;
  assert.equal(priority.priority, 0);
  assert.ok(scene.claimSources.some(s => s.claim === priority.evidence && scene.sources[s.source]!.locator === "fixture:t2/scene"));

  const alternative = inspect(scene, variants[profiles.indexOf("dp-2lane")]!.result);
  const fallback = alternative.work("video"), superspeed = alternative.work("hub");
  assert.deepEqual([fallback.outcome.verdict, fallback.outcome.mode, fallback.metric.value, fallback.option.profile],
    ["conditional", "uncompressed", 12.542736, "dp-2lane"]);
  assert.deepEqual([superspeed.outcome.verdict, superspeed.metric.value, superspeed.option.profile], ["ok", 400, "dp-2lane"]);
  assert.ok(fallback.reasons.some(r => r.stage === "path" && r.rule.includes("60 Hz 폴백")));
  assert.ok(alternative.cited(fallback.inputs, "pin", "D", "fixture:t2/configuration"));
  assert.ok(superspeed.reasons.some(r => r.stage === "negotiate" && r.rule.includes("USB 3.2 Gen 1x1")));
  assert.ok(fallback.specs.includes("dp-alt-mode") && superspeed.specs.includes("usb3-estimate"));

  const usbOnly = inspect(scene, variants[profiles.indexOf("usb-only")]!.result);
  const output = usbOnly.work("hub");
  assert.deepEqual([output.outcome.verdict, output.metric.value, output.option.profile], ["ok", 400, "usb-only"]);
  assert.equal(usbOnly.result.outcomes.find(o => o.subjectKind === "workload" && o.domain === "display")?.verdict, "impossible");
});


test("T2 두 방향에서 핀 D는 USB 3.x 한 레인만 남기고 USB 전용은 두 레인을 사용할 수 있다", () => {
  const scene = fixture("scene");
  for (const c of scene.claims) {
    if (c.ownerKind === "interface" && c.domain === "data" && c.field === "modes")
      c.value = "High Speed, Gen 1x1, Gen 2x2";
    if (c.field === "cableDataGbps") c.value = 20;
  }
  const { result } = inspect(scene);
  for (const direction of ["forward", "reverse"]) {
    const options = result.options.filter(o => o.domain === "data" && o.direction === direction);
    assert.deepEqual(options.map(o => [o.profile, o.limit]), [[undefined, 53.248], ["usb-only", 2200], ["dp-2lane", 450]]);
    assert.equal(options[0]!.pool?.id, "usb2-bulk");
    assert.ok(options[2]!.inputs.some(row => scene.claims[row]!.field === "pin" && scene.claims[row]!.value === "D"));
  }
});

test("T2 우선순위 생략 시 고정 영상 요청을 먼저 세우고 명시적인 허브 우선은 그보다 앞선다", () => {
  const s = fixture("scene");
  for (const m of s.members) { delete m.priority; delete m.evidence; }
  const profiles = evaluateVariants(s,plugins,0);
  assert.equal(profiles[0]!.choices[0]!.profile,"dp-4lane");
  assert.ok(profiles.some(v => v.choices[0]?.profile === "dp-2lane"));
  const base = inspect(s,profiles[0]!.result);
  assert.equal(base.work("video").metric.value,15.674472);
  assert.equal(base.work("hub").metric.value,53.248);
  s.members.find(m => s.workloads[m.workload]!.id === "hub")!.priority = 0;
  assert.equal(evaluateVariants(s,plugins,0)[0]!.choices[0]!.profile,"dp-2lane");
});

for (const both of [false,true]) test("T2 핀 C " + (both ? "양쪽" : "한쪽") + " 미확인 시 핀 D 폴백과 허브 범위를 함께 설명한다", () => {
  const s = fixture("scene");
  const pins = s.claims.flatMap((c,i) => c.field === "pin" && c.value === "C" ? [i] : []).slice(0,both ? 2 : 1);
  for (const i of pins) Object.assign(s.claims[i]!,{value:null, confidence:"unknown"});
  const r = evaluate(s,plugins);
  for (const [id,low,high,possible] of [
    ["video",12.542736,15.674472,["conditional"]],["hub",53.248,400,["conditional","ok"]],
  ] as const) {
    const row = r.outcomes.findIndex(o => o.subjectKind === "workload" && s.workloads[o.subjectRow]!.id === id);
    const m = r.metrics.find(m => m.outcome === row && m.kind === "together")!;
    assert.deepEqual([m.value,m.low,m.high],[null,low,high]);
    for (const world of [m.lowWorld,m.highWorld]) {
      assert.ok(world !== undefined);
      assert.ok(pins.every(pin => r.profileWorlds.some(v => v.world === world && v.claim === pin)));
    }
    assert.deepEqual(r.possibleVerdicts.filter(v => v.outcome === row).map(v => v.verdict).sort(),possible);
    for (const pin of pins) assert.ok(r.quests.some(q => q.outcome === row && q.claim === pin && q.impact === (id === "hub" ? "verdict" : "range")));
  }
  assert.equal(r.choices.length,0);
});

test("T2 작업이 없는 연결은 상호 배타적인 핀 배정을 동시에 확정하지 않는다", () => {
  const s = fixture("scene");
  s.members = [];
  const r = evaluate(s,plugins);
  const unset = r.outcomes.filter(o => o.subjectKind === "connection" && o.direction === "forward" && o.label.includes("설정 미정"));
  assert.ok(unset.length >= 2);
  assert.ok(unset.every(o => o.verdict === "unknown" && o.option === undefined));
  assert.ok(unset.every(o => r.reasons.some(reason => reason.outcome === r.outcomes.indexOf(o) && reason.stage === "negotiate")));
  s.claims.find(c => c.field === "pin" && c.value === "C")!.value = null;
  const pending = evaluate(s,plugins);
  assert.ok(pending.outcomes.some(o => o.subjectKind === "connection" && o.domain === "display" && o.label.includes("설정 미정")));
});

test("T2 양 끝의 기본 핀과 대안 핀이 모두 미확인이어도 허브 범위와 확인할 핀이 남는다", () => {
  const s = fixture("scene");
  const pins = s.claims.flatMap((c,i) => c.field === "pin" && (c.value === "C" || c.value === "D") ? [i] : []);
  for (const pin of pins) Object.assign(s.claims[pin]!,{value:null,confidence:"unknown"});
  const r = evaluate(s,plugins);
  const hub = r.outcomes.findIndex(o => o.subjectKind === "workload" && s.workloads[o.subjectRow]!.id === "hub");
  const m = r.metrics.find(m => m.outcome === hub && m.kind === "together")!;
  assert.deepEqual([m.value,m.low,m.high],[null,53.248,400]);
  assert.ok(r.quests.some(q => q.outcome === hub && pins.includes(q.claim)));
  assert.deepEqual(r.choices,[]);
  assert.ok(r.outcomes.some(o => o.subjectKind === "connection" && o.scenario === 0 && o.domain === "display"));
});

test("T2 미확인 핀의 연결 한도는 두 설정의 경계와 확인할 주장을 함께 낸다", () => {
  const s = fixture("scene");
  const pin = s.claims.findIndex(c => c.field === "pin" && c.value === "C");
  Object.assign(s.claims[pin]!, {value:null,confidence:"unknown"});
  const r = evaluate(s,plugins);
  const row = r.outcomes.findIndex(o => o.subjectKind === "connection" && o.domain === "display" && o.direction === "forward");
  assert.equal(r.outcomes[row]!.verdict,"ok");
  const limit = r.metrics.find(m => m.outcome === row && m.kind === "limit");
  assert.deepEqual([limit?.low,limit?.high,limit?.unit],[12.96,25.92,"Gbps"]);
  assert.ok(r.quests.some(q => q.outcome === row && q.claim === pin && q.impact === "range"));
  assert.ok(r.reasonInputs.some(i => i.claim === pin && r.reasons[i.reason]!.outcome === row));
  for (const endpoint of ["12.96","25.92"]) assert.ok(r.reasons.some(reason => reason.outcome === row && reason.rule.includes(endpoint)));
  const evidence = printResults(s,r).split("\n근거\n")[1]!;
  assert.match(evidence,/상한 25\.92 Gbps[^\n]*pin[^\n]*C/u);
});

test("T2 기본이 핀에 따라 달라져도 확인된 2레인 설정을 고정해 비교할 수 있다", () => {
  const s = fixture("scene");
  Object.assign(s.claims.find(c => c.field === "pin" && c.value === "C")!, {value:null,confidence:"unknown"});
  const variants = evaluateVariants(s,plugins,0);
  assert.deepEqual(variants[0]!.choices,[]);
  assert.deepEqual(variants[0]!.result,evaluate(s,plugins));
  const alternatives = variants.slice(1).filter(v => v.choices.some(c => c.profile === "dp-2lane"));
  assert.equal(alternatives.length,1);
  const {work} = inspect(s,alternatives[0]!.result);
  assert.deepEqual([work("video").metric.value,work("hub").metric.value],[12.542736,400]);
  assert.ok(work("video").reasons.some(r => r.rule.includes("60 Hz")));
  assert.ok(variants.slice(1).some(v => v.choices.some(c => c.profile === "usb-only")));
});
