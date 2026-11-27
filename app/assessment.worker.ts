// 브라우저 메인 스레드 밖에서 기본 판정과 요청된 시나리오의 대안을 계산한다.
import { plugins } from "../domains/registry.ts";
import { evaluate, evaluateVariants } from "../engine/evaluate.ts";
import { loadSceneDocuments } from "../scene/load.ts";
import type { EvaluationReply, EvaluationRequest } from "./assessment.ts";

globalThis.addEventListener("message", (event: MessageEvent<EvaluationRequest>) => {
  const { data } = event;
  let reply: EvaluationReply;
  try {
    const scene = loadSceneDocuments(data.document, data.documents, plugins);
    const start = performance.now();
    if (data.kind === "primary") {
      const result = evaluate(scene, plugins);
      reply = { kind: "primary", result, elapsed: performance.now() - start };
    } else {
      const results = evaluateVariants(scene, plugins, data.scenario);
      reply = { kind: "variants", results, elapsed: performance.now() - start };
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    reply = { kind: "error", message: error.message };
  }
  globalThis.postMessage(reply);
});
