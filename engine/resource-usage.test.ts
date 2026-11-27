// 선택한 계획의 실제 전력·데이터 점유량과 전체 용량을 손계산 및 출처와 대조한다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadScene } from "../cli/load.ts";
import { network } from "../domains/network/network.ts";
import { power } from "../domains/power/power.ts";
import { effectiveClaim } from "./contract.ts";
import { evaluate } from "./evaluate.ts";
import { evidenceRows } from "./evidence.ts";

test("T8 총 100 W 중 상시 10 W와 작업 45 W가 55 W를 차지한다", () => {
  const dir = "fixtures/power";
  const scene = loadScene(dir + "/passthrough.json", {modelsDir:dir, connectorsFile:dir + "/connectors.json"}, [power]);
  const capacity = effectiveClaim(scene,"resource",0,"power","capacity")!;
  scene.claims[capacity]!.value = 100;
  scene.claims[effectiveClaim(scene,"workload",0,"power","requestedW")!]!.value = 45;
  const check = () => {
    const r = evaluate(scene,[power]);
    const total = r.resourceUsage.find(x => x.scenario === 0 && x.resourceKind === "scene" && x.resource === 0)!;
    const input = r.resourceUsage.find(x => x.scenario === 0 && x.resourceKind === "link" &&
      r.linkResources[x.resource]!.connection === 0 && r.linkResources[x.resource]!.direction === "forward")!;
    const steps = evidenceRows(r,{reasons:total.reasonRows});
    assert.ok(steps.some(s => r.reasonInputs.some(i => i.reason === s.reason && i.claim === capacity)));
    return [total.used,total.capacity,input.used,input.capacity];
  };
  assert.deepEqual(check(),[55,100,55,60]);
  const reserve = scene.claims.find(c => c.field === "reserveW")!;
  reserve.value = null;
  assert.deepEqual(check(),[null,100,null,60]);
});

test("T7 한 케이블의 이더넷 900 Mbps와 PoE 12 W를 독립 예산과 근거로 보인다", () => {
  const dir = "fixtures/network";
  const scene = loadScene(dir + "/scene.json",{modelsDir:dir,connectorsFile:dir + "/connectors.json"},[network]);
  const scenario = scene.scenarios.findIndex(s => s.id === "poe-12");
  scene.members.push({scenario,workload:scene.workloads.findIndex(w => w.id === "poe-ethernet")});
  const r = evaluate(scene,[network]);
  const rows = r.resourceUsage.filter(u => u.scenario === scenario && u.resourceKind === "link" &&
    r.linkResources[u.resource]!.connection === scene.connections.findIndex(c => c.id === "poe") &&
    r.linkResources[u.resource]!.direction === "forward");
  assert.deepEqual(rows.map(u => [u.unit,u.used]).sort(),[["Mbps",900],["W",12]]);
  assert.ok(rows.every(u => u.reasonRows.length && u.capacity! >= u.used!));
});

test("T8 작업이 없는 시나리오에서도 상시 부하의 실물 출처를 자원에서 찾는다", () => {
  const dir = "fixtures/power";
  const scene = loadScene(dir + "/passthrough.json",{modelsDir:dir,connectorsFile:dir + "/connectors.json"},[power]);
  scene.members = [];
  const r = evaluate(scene,[power]);
  const u = r.resourceUsage.find(x => x.scenario === 0 && x.resourceKind === "scene" && x.resource === 0)!;
  assert.equal(u.used,10);
  const reasons = new Set(evidenceRows(r,{reasons:u.reasonRows}).map(s => s.reason));
  assert.ok(r.reasonInputs.some(i => reasons.has(i.reason) && scene.claims[i.claim]!.field === "reserveW" &&
    scene.claimSources.some(cs => cs.claim === i.claim)));
});
