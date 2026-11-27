// 합성 장면을 로더부터 판정까지 실행해 영상 경로와 주장·규격 출처를 확인한다.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadScene } from "../../cli/load.ts";
import { display } from "../../domains/display/display.ts";
import type { Scene, Value } from "../../engine/contract.ts";
import { evaluate } from "../../engine/evaluate.ts";

function load(modelsDir = import.meta.dirname) {
  return loadScene(join(import.meta.dirname, "scene.json"), {
    modelsDir, connectorsFile: join(import.meta.dirname, "connectors.json"),
  }, [display]);
}

function portClaim(scene: Scene, itemId: string, portId: string, field: string) {
  const item = scene.items.findIndex(i => i.id === itemId);
  const port = scene.ports.findIndex(p => p.item === item && p.id === portId);
  const row = scene.interfaces.findIndex(i => i.port === port && i.domain === display.id);
  const ownerKind = field === "attachment" ? "port" : "interface";
  const claim = scene.claims.findIndex(c => c.ownerKind === ownerKind && c.owner === (ownerKind === "port" ? port : row) && c.field === field);
  assert.ok(claim >= 0, `${itemId}.${portId}.${field}`);
  return claim;
}

function setPortValue(scene: Scene, itemId: string, portId: string, field: string, value: Value) {
  scene.claims[portClaim(scene, itemId, portId, field)]!.value = value;
}

function setWorkloadValue(scene: Scene, id: string, field: string, value: Value) {
  const owner = scene.workloads.findIndex(work => work.id === id);
  const claim = scene.claims.find(c => c.ownerKind === "workload" && c.owner === owner && c.field === field);
  assert.ok(claim, `${id}.${field}`);
  claim.value = value;
}

function inspect(scene: Scene, id: string) {
  const result = evaluate(scene, [display]);
  assert.deepEqual(result.errors, []);
  const workload = scene.workloads.findIndex(w => w.id === id);
  const index = result.outcomes.findIndex(o => o.subjectKind === "workload" && o.subjectRow === workload);
  const outcome = result.outcomes[index]!;
  assert.ok(outcome.path !== null);
  const steps = result.steps.filter(s => s.path === outcome.path);
  const link = steps.find(s => s.kind === "connection");
  assert.ok(link?.option !== undefined && link.option !== null);
  assert.ok(result.physical.some(p => p.connection === link.row && p.direction === link.direction && p.kind === "mate" && p.verdict === "ok"));
  const option = result.options[link.option]!;
  const demand = result.demands[result.paths[outcome.path]!.demand]!;
  const rows = new Set(result.reasons.flatMap((r, row) => r.outcome === index ? [row] : []));
  const reasons = [...rows].map(row => result.reasons[row]!);
  assert.ok(reasons.some(r => r.stage === "physical"));
  assert.ok(reasons.some(r => r.stage === "path"));
  assert.ok(reasons.some(r => r.stage === "judge"));
  const claims = result.reasonInputs.filter(r => rows.has(r.reason)).map(r => r.claim);
  const specs = result.reasonSpecs.filter(r => rows.has(r.reason)).map(r => result.specSources[r.source]?.id);
  assert.ok(specs.includes("cvt-rb-v2"));
  return { result, outcome, reasons, claims, specs, option, demand, steps, metrics: result.metrics.filter(m => m.outcome === index),
    quests: result.quests.filter(q => q.outcome === index), possible: result.possibleVerdicts.filter(v => v.outcome === index).map(v => v.verdict).sort() };
}

test("T1 DP 1.4와 DP 2.1이 HBR3로 연결되며 양 끝 판본과 수신기의 미사용 성능을 설명한다", () => {
  const scene = load();
  const r = inspect(scene, "native");
  assert.equal(r.outcome.verdict, "ok");
  assert.equal(r.option.limit, 25.92);
  assert.ok(r.demand.requested! < r.option.limit);
  assert.equal(r.option.direction, "forward");
  assert.ok(r.steps.some(s => s.kind === "edge" && scene.edges[s.row]!.id === "a-b"));
  const versions = [portClaim(scene, "host", "dp", "version"), portClaim(scene, "native", "dp", "version")];
  assert.deepEqual(versions.map(row => scene.claims[row]!.value), ["1.4", "2.1"]);
  assert.ok(versions.every(row => r.claims.includes(row)));
  assert.deepEqual(versions.map(row => scene.sources[scene.claimSources.find(c => c.claim === row)!.source]!.id), ["video-source", "video-sink"]);
  assert.ok(r.specs.includes("dp-rates") && r.specs.includes("dp-versions"));
  assert.ok(r.reasons.some(reason => reason.stage === "allocate"));
  assert.equal(r.metrics.find(m => m.kind === "unused")?.value, 20 * 4 * (128 / 132) - 25.92);
  assert.equal(r.result.outcomes.find(o => o.subjectKind === "connection" && o.subjectRow === r.option.connection && o.direction === "reverse")?.verdict, "impossible");
});

test("DP는 양 끝과 케이블의 공통 링크 속도와 레인 수를 각각 구한다", () => {
  const scene = load();
  setPortValue(scene, "wire-native", "a", "lanes", 2);
  setPortValue(scene, "wire-native", "b", "maxRate", "HBR2");
  const r = inspect(scene, "native");
  assert.equal(r.outcome.verdict, "impossible");
  assert.equal(r.option.limit, 8.64);
  assert.ok(r.claims.includes(portClaim(scene, "wire-native", "a", "lanes")));
  assert.ok(r.claims.includes(portClaim(scene, "wire-native", "b", "maxRate")));
  assert.ok(r.specs.includes("dp-rates"));
});

test("4K 144 Hz 10 bpc가 양 끝의 공통 DSC 12 bpp에서 조건부로 성립한다", () => {
  const scene = load();
  const r = inspect(scene, "dsc");
  assert.equal(r.outcome.verdict, "conditional");
  assert.equal(r.outcome.mode, "dsc:12");
  assert.equal(r.option.limit, 25.92);
  const work = r.demand.workload;
  assert.ok(r.result.demands.find(d => d.workload === work && d.preference === 0)!.requested! > r.option.limit);
  assert.ok(r.demand.requested! < r.option.limit);
  assert.ok(r.reasons.some(reason => reason.stage === "negotiate" && reason.rule.includes("DSC 12 bpp")));
  assert.ok(r.specs.includes("dsc") && r.specs.includes("dp-rates"));
  assert.ok(r.claims.includes(portClaim(scene, "host", "dp", "dscBpp")));
  assert.ok(r.claims.includes(portClaim(scene, "native", "dp", "dscBpp")));
  assert.ok(r.claims.some(row => scene.claims[row]!.ownerKind === "workload" && scene.claims[row]!.field === "dscBpp"));
});

test("송신만 DSC를 지원하면 요청은 불가하고 명시한 60 Hz 폴백은 조건부로 성립한다", () => {
  const scene = load();
  setPortValue(scene, "native", "dp", "dscBpp", 0);
  const blocked = inspect(scene, "dsc");
  assert.equal(blocked.outcome.verdict, "impossible");
  assert.equal(blocked.result.options.find(o => o.connection === blocked.option.connection && o.direction === "forward" && o.mode === "dsc:12")?.verdict, "impossible");
  const fallback = inspect(scene, "with-fallback");
  assert.equal(fallback.outcome.verdict, "conditional");
  assert.equal(fallback.outcome.mode, "uncompressed");
  assert.equal(fallback.demand.preference, 2);
  assert.ok(fallback.reasons.some(reason => reason.stage === "path" && reason.rule.includes("60 Hz 폴백")));
  assert.ok(fallback.reasons.some(reason => reason.stage === "negotiate" && reason.rule.includes("공통 DSC 목표가 없음")));
  assert.ok(fallback.claims.includes(portClaim(scene, "native", "dp", "dscBpp")));
  assert.ok(fallback.specs.includes("dsc"));
});

test("DSC 지원값이 미확인이면 압축이 필요한 작업은 미확인이고 알려진 비압축 작업은 성립한다", () => {
  const scene = load();
  setPortValue(scene, "native", "dp", "dscBpp", null);
  const r = inspect(scene, "dsc");
  assert.equal(r.outcome.verdict, "unknown");
  assert.ok(r.reasons.some(reason => reason.stage === "negotiate" && reason.rule.includes("DSC 전송 조건")));
  assert.ok(r.specs.includes("dsc") && r.claims.includes(portClaim(scene, "native", "dp", "dscBpp")));
  assert.equal(inspect(scene, "native").outcome.verdict, "ok");
});

test("허용 모드가 모두 한도를 넘으면 막은 링크와 규격 출처가 남는다", () => {
  const r = inspect(load(), "too-large");
  assert.equal(r.outcome.verdict, "impossible");
  assert.ok(r.demand.requested! > r.option.limit!);
  assert.ok(r.reasons.some(reason => reason.stage === "negotiate" && reason.targetRow === r.option.connection && reason.rule.includes("25.92 Gbps")));
  assert.ok(r.specs.includes("dp-rates"));
});

test("T3 포트의 출력 GPU가 미확인이면 후보 경로와 확인할 부착점 주장이 남는다", () => {
  const scene = load();
  const r = inspect(scene, "unresolved");
  assert.equal(r.outcome.verdict, "unknown");
  assert.equal(r.option.verdict, "ok");
  assert.ok(r.claims.includes(portClaim(scene, "host", "unresolved", "attachment")));
  assert.ok(r.specs.includes("dp-rates"));
  assert.equal(display.quest("attachment"), "이 포트가 어느 출력 GPU에 연결되는지 확인하세요.");
  const attachment = scene.claims[portClaim(scene, "host", "unresolved", "attachment")]!;
  attachment.reference = scene.nodes.findIndex(n => n.id === "gpu-a");
  assert.equal(inspect(scene, "unresolved").outcome.verdict, "ok");
  attachment.reference = scene.nodes.findIndex(n => n.id === "gpu-b");
  assert.equal(evaluate(scene, [display]).outcomes.find(o => o.subjectKind === "workload" && o.subjectRow === r.demand.workload)?.verdict, "impossible");
});

test("USB-C DP Alt Mode 핀 C의 4레인에서는 성립하고 핀 D의 2레인에서는 불가하다", () => {
  const scene = load();
  const c = inspect(scene, "alt-c");
  const d = inspect(scene, "alt-d");
  assert.equal(c.outcome.verdict, "ok");
  assert.equal(c.option.limit, 25.92);
  assert.equal(d.outcome.verdict, "impossible");
  assert.equal(d.option.limit, 12.96);
  assert.equal(c.demand.requested, d.demand.requested);
  for (const [id, r] of [["alt-c", c], ["alt-d", d]] as const) {
    assert.ok(r.claims.includes(portClaim(scene, "host", id, "pin")));
    assert.ok(r.claims.includes(portClaim(scene, id, id, "pin")));
    assert.ok(r.specs.includes("dp-alt-mode") && r.specs.includes("dp-rates"));
  }
});

test("HDMI는 공통 FRL 한도 또는 경로가 선언한 TMDS 한도로 영상 수요를 판정한다", () => {
  const scene = load();
  const frl = inspect(scene, "hdmi");
  assert.equal(frl.outcome.verdict, "ok");
  assert.equal(frl.option.limit, 16);
  assert.ok(frl.reasons.some(reason => reason.stage === "negotiate" && reason.rule.includes("FRL")));
  assert.ok(frl.specs.includes("hdmi-frl"));
  assert.ok(frl.claims.includes(portClaim(scene, "hdmi", "hdmi", "frlCode")));
  setPortValue(scene, "hdmi", "hdmi", "frlCode", 0);
  const tmds = inspect(scene, "hdmi");
  assert.equal(tmds.outcome.verdict, "ok");
  assert.equal(tmds.option.limit, 14.4);
  assert.ok(tmds.reasons.some(reason => reason.stage === "negotiate" && reason.rule.includes("TMDS")));
  assert.ok(tmds.specs.includes("hdmi-tmds"));
  assert.ok(tmds.claims.includes(portClaim(scene, "hdmi", "hdmi", "tmdsVersion")));
});

test("HDMI의 FRL 미확인은 TMDS로 충분한 작업과 FRL 상한을 넘는 작업의 판정을 바꾸지 않는다", () => {
  const scene = load();
  const claim = portClaim(scene, "hdmi", "hdmi", "frlCode");
  scene.claims[claim]!.value = null;
  for (const [refresh, verdict] of [[60, "ok"], [144, "unknown"], [300, "impossible"]] as const) {
    setWorkloadValue(scene, "hdmi", "refresh", refresh);
    const r = inspect(scene, "hdmi");
    assert.equal(r.outcome.verdict, verdict, `${refresh} Hz`);
    assert.equal(r.option.limit, null);
    assert.deepEqual(r.option.bounds, { low: 14.4, high: 32 * (16 / 18) });
    assert.ok(r.claims.includes(claim));
    assert.ok(r.specs.includes("hdmi-tmds") && r.specs.includes("hdmi-frl"));
    const metric = r.metrics.find(m => m.kind === "together")!;
    if (verdict === "unknown") {
      assert.deepEqual(r.possible, ["impossible", "ok"]);
      assert.deepEqual([metric.low, metric.high], [0, r.demand.requested]);
      assert.ok(r.quests.some(q => q.claim === claim && q.instruction === display.quest("frlCode")));
    } else {
      const value = verdict === "ok" ? 7.0377 : 0;
      assert.deepEqual([metric.value, metric.low, metric.high], [value, value, value]);
      assert.deepEqual(r.quests, []);
    }
  }
  setWorkloadValue(scene, "hdmi", "refresh", 60);
  for (const code of [0, 1, 2, 3, 4, 5, 6]) {
    scene.claims[claim]!.value = code;
    const r = inspect(scene, "hdmi");
    assert.equal(r.outcome.verdict, "ok", `FRL ${code}`);
    assert.equal(r.metrics.find(m => m.kind === "together")?.value, 7.0377);
  }
});

test("HDMI의 DSC 모드는 TMDS 보장 한도 대신 FRL 경계를 쓴다", () => {
  const scene = load();
  const owner = scene.workloads.findIndex(w => w.id === "hdmi");
  const dsc = scene.workloads.findIndex(w => w.id === "dsc");
  const target = scene.claims.find(c => c.ownerKind === "workload" && c.owner === dsc && c.field === "dscBpp")!;
  scene.claims.push({ ...target, owner });
  setPortValue(scene, "host", "hdmi", "dscBpp", 12);
  setPortValue(scene, "hdmi", "hdmi", "dscBpp", 12);
  setPortValue(scene, "hdmi", "hdmi", "frlCode", null);
  setWorkloadValue(scene, "hdmi", "refresh", 144);
  const pending = inspect(scene, "hdmi");
  const compressed = pending.result.options.find(o => o.direction === "forward" &&
    o.connection === pending.option.connection && o.mode === "dsc:12");
  assert.equal(pending.outcome.verdict, "unknown");
  assert.deepEqual(compressed?.bounds, { low: 0, high: 32 * (16 / 18) });
  assert.ok(pending.quests.some(q => q.claim === portClaim(scene, "hdmi", "hdmi", "frlCode")));

  setPortValue(scene, "hdmi", "hdmi", "frlCode", 1);
  const known = inspect(scene, "hdmi");
  assert.equal(known.outcome.verdict, "conditional");
  assert.equal(known.outcome.mode, "dsc:12");
  assert.equal(known.option.limit, 8);
  assert.ok(known.reasons.some(r => r.stage === "negotiate" && r.rule.includes("FRL") && r.rule.includes("8 Gbps")));
});

test("DP 레인 수와 속도가 미확인이어도 알려진 포트와 규격이 경계를 제한한다", () => {
  const scene = load();
  setPortValue(scene, "host", "dp", "lanes", null);
  const lanes = inspect(scene, "native");
  assert.equal(lanes.outcome.verdict, "unknown");
  assert.deepEqual(lanes.option.bounds, { low: 6.48, high: 25.92 });
  assert.ok(lanes.quests.some(q => q.claim === portClaim(scene, "host", "dp", "lanes")));

  setPortValue(scene, "host", "dp", "lanes", 4);
  setPortValue(scene, "host", "dp", "maxRate", null);
  setPortValue(scene, "host", "dp", "version", "1.2");
  const rate = inspect(scene, "native");
  assert.equal(rate.outcome.verdict, "unknown");
  assert.deepEqual(rate.option.bounds, { low: 1.62 * 4 * 0.8, high: 17.28 });
  assert.ok(rate.quests.some(q => q.claim === portClaim(scene, "host", "dp", "maxRate")));

  setWorkloadValue(scene, "native", "refresh", 15);
  const guaranteed = inspect(scene, "native");
  assert.equal(guaranteed.outcome.verdict, "ok");
  assert.deepEqual(guaranteed.quests, []);
  setWorkloadValue(scene, "native", "refresh", 90);
  const blocked = inspect(scene, "native");
  assert.equal(blocked.outcome.verdict, "impossible");
  assert.deepEqual(blocked.quests, []);
});

test("모델에 DP 레인 수 필드가 없으면 로드 위치에서 거절하고 명시적인 null에는 퀘스트를 낸다", t => {
  const work = join(import.meta.dirname, "../../work");
  mkdirSync(work, { recursive: true });
  const modelsDir = mkdtempSync(join(work, "영상입력시험-"));
  t.after(() => rmSync(modelsDir, { recursive: true, force: true }));
  for (const name of ["video-sink@1.json", "video-wire@1.json"])
    cpSync(join(import.meta.dirname, name), join(modelsDir, name));
  const name = "video-source@1.json";
  const model = JSON.parse(readFileSync(join(import.meta.dirname, name), "utf8"));
  const params = model.ports[0].interfaces[0].params;
  const lanes = params.lanes;
  const file = join(modelsDir, name);
  delete params.lanes;
  writeFileSync(file, JSON.stringify(model));
  assert.throws(() => load(modelsDir), /video-source@1\.json#ports\.0\.interfaces\.0\.params\.lanes/);
  params.lanes = { ...lanes, value: null, confidence: "unknown" };
  writeFileSync(file, JSON.stringify(model));
  const scene = load(modelsDir);
  const r = inspect(scene, "native");
  assert.equal(r.outcome.verdict, "unknown");
  assert.ok(r.quests.some(q => q.claim === portClaim(scene, "host", "dp", "lanes")));
});

test("DP·Alt Mode·HDMI 입력은 각자의 필수 칸에 명시적인 null을 허용한다", () => {
  const dp = { version: { value: null, unit: "" }, maxRate: { value: null, unit: "" },
    lanes: { value: null, unit: "" }, dscBpp: { value: null, unit: "bpp" } };
  const hdmi = { tmdsVersion: { value: null, unit: "" }, frlCode: { value: null, unit: "" }, dscBpp: dp.dscBpp };
  const alt = { ...dp, pin: { value: null, unit: "" } };
  for (const [protocol, fields] of [["DP", dp], ["DP Alt Mode", alt], ["HDMI", hdmi]] as const) {
    const schema = display.paramsFor?.(protocol) ?? display.params;
    assert.ok(schema.safeParse(fields).success, protocol);
    for (const field of Object.keys(fields)) {
      const missing = Object.fromEntries(Object.entries(fields).filter(([name]) => name !== field));
      const parsed = schema.safeParse(missing);
      assert.equal(parsed.success, false, `${protocol}.${field}`);
      assert.ok(!parsed.success && parsed.error.issues.some(issue => issue.path[0] === field));
    }
  }
  assert.equal((display.paramsFor?.("DP") ?? display.params).safeParse({ ...dp, frlCode: hdmi.frlCode }).success, false);
});
