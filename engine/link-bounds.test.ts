// 미확인 링크의 두 경계에서 고정 요청과 연속 요청이 얻는 판정·성능을 손계산으로 확인한다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadScene } from "../cli/load.ts";
import { trialDomain } from "../fixtures/trial.ts";
import { evaluate } from "./evaluate.ts";

test("T1 링크 한도 50–80에서 고정 요청은 보장·미확인·불가로 갈린다", () => {
  for (const [amount, verdict, low, high] of [[50,"ok",50,50], [80,"unknown",0,80], [81,"impossible",0,0]] as const) {
    const { o, metric, possible } = bounded(false, amount);
    assert.deepEqual([o.verdict, metric.low, metric.high], [verdict, low, high]);
    assert.deepEqual(possible, verdict === "unknown" ? ["impossible","ok"] : [verdict]);
  }
});

test("T5 연속 요청은 한도 하한에서도 달성하는 성능을 보존한다", () => {
  for (const [amount, verdict, low, high] of [[45,"ok",45,45], [60,"unknown",50,60], [100,"conditional",50,80]] as const) {
    const { o, metric } = bounded(true, amount);
    assert.deepEqual([o.verdict, metric.low, metric.high], [verdict, low, high]);
  }
});

function bounded(elastic: boolean, requested: number, pair = false, unknownPolicy = false, shareLink = true) {
  const trial = trialDomain();
  const scene = loadScene("fixtures/three-flows.json", { modelsDir: "fixtures", connectorsFile: "fixtures/connectors.json" }, [trial]);
  scene.members = scene.members.slice(0, pair ? 2 : 1);
  if (pair && shareLink) scene.workloads[1]!.to = scene.workloads[0]!.to;
  if (unknownPolicy) scene.claims.find(c => c.ownerKind === "resource" && c.field === "policy")!.value = null;
  const plugin = { ...trial,
    negotiate: (link: Parameters<typeof trial.negotiate>[0]) => trial.negotiate(link).map(o =>
      ({ ...o, verdict: "unknown" as const, limit: null, bounds: { low: 50, high: 80 } })),
    demand: (...args: Parameters<typeof trial.demand>) => trial.demand(...args).map(d => ({ ...d, elastic, requested })),
  };
  const r = evaluate(scene, [plugin]), row = r.outcomes.findIndex(o => o.subjectKind === "workload");
  return { o: r.outcomes[row]!, metric: r.metrics.find(m => m.outcome === row && m.kind === "together")!,
    possible: r.possibleVerdicts.filter(v => v.outcome === row).map(v => v.verdict).sort() };
}

test("T1 상위 링크 경계가 요청과 겹쳐도 성립하는 폴백은 가능한 판정에 남는다", () => {
  const trial = trialDomain(), scene = loadScene("fixtures/three-flows.json",
    { modelsDir: "fixtures", connectorsFile: "fixtures/connectors.json" }, [trial]);
  scene.members = scene.members.slice(0, 1);
  const plugin = { ...trial,
    negotiate: (link: Parameters<typeof trial.negotiate>[0]) => trial.negotiate(link).flatMap(o => [
      { ...o, verdict: "unknown" as const, limit: null, bounds: { low: 20, high: 100 } }, { ...o, mode: "fallback", limit: 40 }
    ]),
    demand: (...args: Parameters<typeof trial.demand>) => trial.demand(...args).flatMap(d => [
      { ...d, elastic: false, requested: 80 }, { ...d, elastic: false, requested: 40, preference: 1, mode: "fallback" }
    ]),
  };
  const r = evaluate(scene, [plugin]), row = r.outcomes.findIndex(o => o.subjectKind === "workload");
  assert.equal(r.outcomes[row]!.verdict, "unknown");
  assert.deepEqual(r.possibleVerdicts.filter(v => v.outcome === row).map(v => v.verdict).sort(), ["conditional","ok"]);
  const metric = r.metrics.find(m => m.outcome === row && m.kind === "together")!;
  assert.deepEqual([metric.low, metric.high], [40,80]);
});

test("T5 같은 링크의 범위를 연속 작업 둘이 나누면 각 끝의 max-min 성능을 쓴다", () => {
  const { o, metric, possible } = bounded(true, 100, true);
  assert.deepEqual([o.verdict, metric.low, metric.high, possible], ["conditional",25,40,["conditional"]]);
});

test("T5 링크와 정책이 함께 미확인이어도 가능한 판정은 한 번씩만 남는다", () => {
  const { o, metric, possible } = bounded(true, 100, true, true);
  assert.deepEqual([o.verdict, metric.low, metric.high, possible], ["unknown",0,80,["conditional","impossible"]]);
});

test("T5 경쟁자가 있어도 각자 쓰는 링크의 보장 하한은 남는다", () => {
  const { o, metric, possible } = bounded(true, 100, true, false, false);
  assert.deepEqual([o.verdict, metric.low, metric.high, possible], ["conditional",50,80,["conditional"]]);
});
