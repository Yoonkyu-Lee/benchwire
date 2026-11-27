// 저장 파일의 구조와 값 경계를 검증한다. 지역 참조와 영역별 필드는 로더가 해석한다.
import { z } from "zod";

export const id = z.string().min(1);
const ids = z.array(id).nonempty();
const confidence = z.enum(["official", "review", "community", "user_verified", "inferred", "unknown"]);
const fact = z.strictObject({
  value: z.union([z.number(), z.string(), z.boolean(), z.null()]), unit: z.string().default(""),
  confidence, sources: ids, condition: z.string().default(""),
}).refine(f => f.confidence !== "unknown" || f.value === null, "미확인 값은 null이어야 합니다");
export type Fact = z.infer<typeof fact>;
const evidence = fact.refine(f => f.value === true && !f.unit && !f.condition, "구조 근거에는 무조건 성립하는 참값이 필요합니다");
const fields = z.record(id, fact);
const sources = z.array(z.strictObject({ id, title: id, locator: id, retrievedAt: z.iso.date() }));
const localRef = z.strictObject({ instanceId: id, id });
const fileId = z.string().regex(/^[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*$/u, "파일 이름에 쓸 수 없는 ID입니다");

export const connectorsFile = z.strictObject({
  sources, connectors: z.array(z.strictObject({ id, endForm: fact })),
  mates: z.array(z.strictObject({ a: id, b: id, evidence })),
});
export const modelFile = z.strictObject({
  modelId: fileId, revision: fileId, kind: z.enum(["device", "cable", "adapter"]), name: id, brand: id, category: id,
  sources, attributes: z.record(id, fields).default({}),
  nodes: z.array(z.strictObject({ id, label: id, kind: id })),
  ports: z.array(z.strictObject({
    id, label: id, location: z.string().default(""), connector: fact, attachment: fact,
    interfaces: z.array(z.strictObject({ id, protocol: id, role: id, domain: id, evidence, params: fields })),
  })),
  edges: z.array(z.strictObject({
    id, from: id, to: id, evidence, uses: z.array(z.strictObject({ resource: id, evidence })),
  })),
  resources: z.array(z.strictObject({ id, kind: id, domain: id, unit: id, capacity: fact, policy: fact })),
});
export const sceneFile = z.strictObject({
  sceneId: id, sources,
  items: z.array(z.strictObject({ instanceId: id, modelId: fileId, revision: fileId, alias: z.string().default(""), state: z.string().default("") })),
  personal: z.array(z.strictObject({
    instanceId: id, ownerKind: z.enum(["resource", "interface", "item", "port"]), ownerId: id,
    domain: z.string(), field: id, claim: fact.refine(f => f.confidence === "user_verified", "개인 주장에는 사용자 검증이 필요합니다"),
  })).default([]),
  connections: z.array(z.strictObject({
    id, from: localRef, to: localRef, evidence, parts: z.array(z.strictObject({ instanceId: id, entry: id, exit: id })),
  })),
  workloads: z.array(z.strictObject({ id, domain: id, kind: id, from: localRef, to: localRef, request: fields })),
  scenarios: z.array(z.strictObject({ id, members: z.array(z.union([id, z.strictObject({ workload: id, priority: fact.refine(f =>
    typeof f.value === "number" && Number.isSafeInteger(f.value) && !f.unit && !f.condition, "우선순위에는 단위 없는 정수가 필요합니다") })])) })),
});
