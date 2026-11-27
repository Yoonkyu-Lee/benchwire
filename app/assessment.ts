// 저장 문서를 검증하고 편집별 최신 평가 요청을 전용 워커에 보낸다.
import { plugins } from "../domains/registry.ts";
import type { evaluateVariants } from "../engine/evaluate.ts";
import type { Results } from "../engine/results.ts";
import { loadSceneDocuments } from "../scene/load.ts";
import type { Library, Model, SceneDocument } from "./document.ts";

export interface Documents { connectors: Library["connectors"]; models: ReadonlyMap<string, Model> }
export type Variants = ReturnType<typeof evaluateVariants>;

export function loadAssessment(document: SceneDocument, documents: Documents, scenarioId: string | null) {
  let scene;
  try { scene = loadSceneDocuments(document, documents, plugins); }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    return { error: error.message };
  }
  const preferred = scene.scenarios.findIndex(s => s.id === scenarioId);
  const scenario = preferred >= 0 ? preferred : scene.scenarios.length ? 0 : null;
  return { scene, scenario };
}
export type Assessment = Exclude<ReturnType<typeof loadAssessment>, { error: string }>;

export type EvaluationRequest = { document: SceneDocument; documents: Documents } &
  ({ kind: "primary" } | { kind: "variants"; scenario: number });
export type EvaluationReply =
  | { kind: "primary"; result: Results; elapsed: number }
  | { kind: "variants"; results: Variants; elapsed: number }
  | { kind: "error"; message: string };

interface Job { owner: object; request: EvaluationRequest; complete: (reply: EvaluationReply | undefined) => void }
const pending = new Map<object, Job>();
let active: Job | undefined;
let worker: Worker | undefined;

export function evaluateInWorker(owner: object, request: EvaluationRequest) {
  return new Promise<EvaluationReply | undefined>(complete => {
    pending.get(owner)?.complete(undefined);
    const job = { owner, request, complete };
    if (active?.owner === owner && request.kind === "primary") {
      active.complete(undefined);
      worker?.terminate();
      worker = undefined;
      pending.delete(owner);
      start(job);
    } else {
      pending.set(owner, job);
      send();
    }
  });
}

function send() {
  if (active || !pending.size) return;
  const [owner, job] = pending.entries().next().value!;
  pending.delete(owner);
  start(job);
}

function start(job: Job) {
  active = job;
  try {
    if (!worker) {
      const instance = new Worker(new URL("./assessment.worker.ts", import.meta.url), { type: "module" });
      instance.onmessage = (event: MessageEvent<EvaluationReply>) => { if (worker === instance) finish(event.data); };
      instance.onerror = event => {
        event.preventDefault();
        if (worker === instance) stop("판정 워커 오류: " + event.message);
      };
      instance.onmessageerror = () => { if (worker === instance) stop("판정 결과를 읽을 수 없습니다."); };
      worker = instance;
    }
    worker.postMessage(job.request);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    stop(error.message);
  }
}

function stop(message: string) {
  worker?.terminate();
  worker = undefined;
  finish({ kind: "error", message });
}

function finish(reply: EvaluationReply) {
  const job = active;
  active = undefined;
  job?.complete(reply);
  send();
}
