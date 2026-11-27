// 저장 장면의 로드·평가를 묶고 현재 문서의 시나리오별 대안을 보관한다.
import { plugins } from "../domains/registry.ts";
import { evaluate, evaluateVariants } from "../engine/evaluate.ts";
import { loadSceneDocuments } from "../scene/load.ts";
import type { Library, Model, SceneDocument } from "./document.ts";

export interface Documents { connectors: Library["connectors"]; models: ReadonlyMap<string, Model> }
export type Variants = ReturnType<typeof evaluateVariants>;

export function assessDocument(document: SceneDocument, documents: Documents, scenarioId: string | null) {
  let scene;
  try { scene = loadSceneDocuments(document, documents, plugins); }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    return { error: error.message };
  }
  const preferred = scene.scenarios.findIndex(s => s.id === scenarioId);
  const scenario = preferred >= 0 ? preferred : scene.scenarios.length ? 0 : null;
  const first = scenario === null ? [{ choices: [], result: evaluate(scene, plugins) }] : evaluateVariants(scene, plugins, scenario);
  const cached = new Map<number | null, Variants>([[scenario, first]]);
  return {
    scene, scenario, primary: first[0]!.result,
    variants(row: number | null, load = false): Variants {
      const ready = cached.get(row);
      if (ready) return ready;
      if (!load || row === null) return [first[0]!];
      const next = evaluateVariants(scene, plugins, row);
      cached.set(row, next);
      return next;
    },
  };
}
export type Assessment = Exclude<ReturnType<typeof assessDocument>, { error: string }>;
