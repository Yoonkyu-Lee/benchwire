// 같은 로드·평가 단계를 Node와 Edge에서 독립적으로 시간을 잰다.
import { plugins } from "../domains/registry.ts";
import { evaluate, evaluateVariants } from "../engine/evaluate.ts";
import { loadSceneDocuments } from "../scene/load.ts";
import { benchmark } from "./assessment-fixture.ts";
import { modelKey } from "./document.ts";

export function phaseInputs() {
  const { initial, library } = benchmark();
  return { initial, library, documents: { connectors: library.connectors,
    models: new Map(library.models.map(model => [modelKey(model), model])) } };
}

export function enginePhases(inputs: ReturnType<typeof phaseInputs>) {
  const { initial, documents } = inputs;
  const start = performance.now();
  const scene = loadSceneDocuments(initial, documents, plugins);
  const loaded = performance.now();
  const basic = evaluate(scene, plugins);
  const evaluated = performance.now();
  const variants = evaluateVariants(scene, plugins, 0);
  const finished = performance.now();
  return { scene, basic, variants, load: loaded - start, evaluate: evaluated - loaded, variantsTime: finished - evaluated };
}

export function percentiles(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const quantile = (q: number) => Number(sorted[Math.ceil(q * sorted.length) - 1]!.toFixed(2));
  return { p50: quantile(0.5), p95: quantile(0.95), max: quantile(1) };
}
