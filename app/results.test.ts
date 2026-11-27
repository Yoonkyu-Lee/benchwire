// 평가 전에는 포트의 공통 영역을, 평가 뒤에는 판정의 W 단위를 배선에 반영한다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadScene } from "../cli/load.ts";
import { plugins } from "../domains/registry.ts";
import { evaluate } from "../engine/evaluate.ts";
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
  const scene = loadScene("fixtures/example/scene.json", {
    modelsDir: "fixtures/network", connectorsFile: "fixtures/example/connectors.json",
  }, plugins);
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
