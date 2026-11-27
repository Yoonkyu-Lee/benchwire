// 평가 전에는 포트의 공통 영역을, 평가 뒤에는 판정의 W 단위를 배선에 반영한다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadScene } from "../cli/load.ts";
import { plugins } from "../domains/registry.ts";
import { evaluate } from "../engine/evaluate.ts";
import { resourceFacts } from "../engine/scene.ts";
import pd from "../fixtures/network/network-pd@1.json" with { type: "json" };
import pse from "../fixtures/network/network-pse@1.json" with { type: "json" };
import { modelFile } from "../scene/files.ts";
import { wireLayers } from "./layers.ts";
import { resultView } from "./results.ts";

test("평가 전 PoE 배선의 레이어는 양쪽 인터페이스의 공통 영역이다", () => {
  const from = modelFile.parse(pse).ports[0]!;
  const to = modelFile.parse(pd).ports[0]!;
  assert.deepEqual(wireLayers(from, to), ["network"]);
});

test("등록되지 않은 영역 ID의 W 협상과 흐름도 전력 레이어에 둔다", () => {
  const scene = networkExample();
  const result = evaluate(scene, plugins);
  const domain = "test-energy";
  const workload = scene.workloads.findIndex(work => work.id === "poe-12");
  const outcome = result.outcomes.find(row => row.subjectKind === "workload" && row.subjectRow === workload)!;
  outcome.domain = domain;
  for (const row of result.outcomes) if (row.subjectKind === "connection" && row.unit === "W") row.domain = domain;
  for (const step of result.steps) if (step.path === outcome.path && step.carrier) step.carrier = { ...step.carrier, domain };
  const marks = resultView(scene, result, 0, "together").wires.get("poe")!;
  const watts = marks.filter(mark => mark.unit === "W");
  assert.deepEqual(new Set(watts.map(mark => mark.kind)), new Set(["negotiation", "flow"]));
  assert(watts.every(mark => mark.layer === "power"));
  assert(watts.some(mark => mark.title.includes(domain)));
});

function networkExample() {
  return loadScene("fixtures/example/scene.json", {
    modelsDir: "fixtures/network", connectorsFile: "fixtures/network/connectors.json",
  }, plugins);
}

test("사용하지 않는 협상은 능력으로 표시하고 근거에는 상세 판정을 남긴다", () => {
  const scene = networkExample();
  const result = evaluate(scene, plugins);
  const view = resultView(scene, result, 0, "together");
  const power = view.wires.get("poe")!.filter(m => m.kind === "negotiation" && m.unit === "W");
  assert.equal(power.find(m => m.direction === "forward")!.verdict, "ok");
  const reverse = power.find(m => m.direction === "reverse")!;
  assert.equal(reverse.verdict, null);
  assert.doesNotMatch(reverse.text, /❌/);
  assert.match(reverse.title, /❌/);

  const idle = resultView(scene, evaluate({ ...scene, members: [] }, plugins), 0, "together");
  assert(idle.wires.get("poe")!.every(m => m.verdict === null));
});

test("균등 분배 가정은 보수적 범위와 구별하여 가정값을 표시한다", () => {
  const scene = networkExample();
  const uplink = scene.resources.findIndex(r => r.id === "uplink");
  scene.claims[resourceFacts(scene, uplink).policy]!.value = null;
  const view = resultView(scene, evaluate(scene, plugins), 0, "together");
  const expected = "0–900 Mbps · 보수적 경계 · 가정 600 Mbps";
  assert.equal(view.workloads.find(w => w.id === "lan-a")!.summary, expected);
  assert(view.wires.get("uplink")!.find(m => m.workload === "lan-a")!.text.includes(expected));
});

test("작업이 없어도 실제 결합 불일치는 물리 판정으로 남는다", () => {
  const scene = networkExample();
  scene.members = [];
  scene.mates = [];
  const marks = resultView(scene, evaluate(scene, plugins), 0, "together").wires.get("poe")!;
  assert(marks.filter(m => m.kind === "negotiation").every(m => m.verdict === null));
  assert.deepEqual(marks.filter(m => m.kind === "physical").map(m => [m.direction, m.verdict]),
    [["forward", "impossible"], ["reverse", "impossible"]]);
});
