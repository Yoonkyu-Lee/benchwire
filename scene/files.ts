// 저장 파일의 구조와 값 경계를 검증한다. 지역 참조와 영역별 필드는 로더가 해석한다.
import { z } from "zod";

export const id = z.string().min(1);
const ids = z.array(id).nonempty();
const confidence = z.enum(["official", "review", "community", "user_verified", "inferred", "unknown"]);
const fileId = z.string().regex(/^[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*$/u, "파일 이름에 쓸 수 없는 ID입니다");
const revisionRef = z.string().refine(key => {
  const parts = key.split("@");
  return parts.length === 2 && parts.every(part => fileId.safeParse(part).success);
}, "원본 판본은 modelId@revision 형식입니다");
const scalar = z.union([z.number(), z.string(), z.boolean()]);
const conflict = z.strictObject({
  value: scalar, unit: z.string().optional(), confidence: confidence.exclude(["unknown"]),
  sources: ids, condition: z.string().optional(), inferredFrom: revisionRef.optional(),
}).refine(c => !c.inferredFrom || c.confidence === "inferred",
  { path: ["inferredFrom"], message: "원본 판본은 복제한 추정값에 붙입니다" });
const fact = z.strictObject({
  value: scalar.nullable(), unit: z.string().default(""), confidence, sources: ids, condition: z.string().default(""),
  conflicts: z.array(conflict).optional(), inferredFrom: revisionRef.optional(),
}).superRefine((f, ctx) => {
  function error(path: (string | number)[], message: string) { ctx.addIssue({ code: "custom", path, message }); }
  if (f.confidence === "unknown" && f.value !== null) error([], "미확인 값은 null이어야 합니다");
  if (f.inferredFrom && (f.value === null || f.confidence !== "inferred"))
    error(["inferredFrom"], "원본 판본은 복제한 추정값에 붙입니다");
  if (f.conflicts?.length && f.value === null) error(["conflicts"], "출처 충돌에는 알려진 본값이 필요합니다");
  f.conflicts?.forEach((c,i) => {
    if (c.value === f.value) error(["conflicts",i,"value"], "본값과 같으면 본값의 출처에 합칩니다");
    if (c.unit !== undefined && c.unit !== f.unit) error(["conflicts",i,"unit"], "충돌 후보의 단위가 다릅니다");
    if (c.condition !== undefined && c.condition !== f.condition) error(["conflicts",i,"condition"], "조건이 다르면 별도 주장입니다");
  });
});
export type Fact = z.infer<typeof fact>;
const evidence = fact.refine(f => f.value === true && !f.unit && !f.condition && !f.conflicts?.length, "구조 근거에는 무조건 성립하는 참값이 필요합니다");
const fields = z.record(id, fact);
const sources = z.array(z.strictObject({ id, title: id, locator: id, retrievedAt: z.iso.date() }));
const localRef = z.strictObject({ instanceId: id, id });
const measurementContext = { firmware: id.optional(), measurementCondition: id.optional() };
const personalFact = fact.refine(f => f.confidence === "user_verified", "개인 주장에는 사용자 검증이 필요합니다");
const observation = z.strictObject({
  ports: z.array(localRef.extend(measurementContext)).min(2), domain: id, field: id,
  claim: personalFact.refine(f => f.value !== null && !f.condition && !f.conflicts?.length, "관측에는 측정한 값 하나가 필요합니다"),
});

export const connectorsFile = z.strictObject({
  sources, connectors: z.array(z.strictObject({ id, endForm: fact, glyph: fileId.optional() })),
  mates: z.array(z.strictObject({ a: id, b: id, evidence })),
});
export const modelFile = z.strictObject({
  modelId: fileId, revision: fileId, kind: z.enum(["device", "cable", "adapter"]), name: id, brand: id, category: id,
  sources, attributes: z.record(id, fields).default({}),
  nodes: z.array(z.strictObject({ id, label: id, kind: id })),
  ports: z.array(z.strictObject({
    id, label: id, location: z.string().default(""), connector: fact, attachment: fact,
    position: z.strictObject({
      face: z.enum(["front", "rear", "left", "right", "top", "bottom"]),
      x: z.number().min(0).max(1), y: z.number().min(0).max(1),
      confidence: confidence.exclude(["unknown", "user_verified"]), sources: ids, inferredFrom: revisionRef.optional(),
    }).refine(position => !position.inferredFrom || position.confidence === "inferred",
      { path: ["inferredFrom"], message: "원본 판본은 복제한 추정값에 붙입니다" }).optional(),
    interfaces: z.array(z.strictObject({ id, protocol: id, role: id, domain: id, evidence, params: fields })),
  })),
  edges: z.array(z.strictObject({
    id, from: id, to: id, evidence, uses: z.array(z.strictObject({ resource: id, evidence })),
  })),
  resources: z.array(z.strictObject({ id, kind: id, domain: id, unit: id, capacity: fact, policy: fact })),
});
export const sceneFile = z.strictObject({
  sceneId: id, sources,
  layout: z.strictObject({
    placements: z.array(z.strictObject({ instanceId: id, x: z.number(), y: z.number() })).optional(),
    viewport: z.strictObject({ cx: z.number(), cy: z.number(), zoom: z.number().positive() }).optional(),
  }).optional(),
  items: z.array(z.strictObject({ instanceId: id, modelId: fileId, revision: fileId, alias: z.string().default(""), state: z.string().default(""), ...measurementContext })),
  personal: z.array(z.strictObject({
    instanceId: id, ownerKind: z.enum(["resource", "interface", "item", "port"]), ownerId: id,
    domain: z.string(), field: id, ...measurementContext, claim: personalFact,
  })).default([]),
  connections: z.array(z.strictObject({
    id, from: localRef, to: localRef, evidence, observations: z.array(observation).optional(), parts: z.array(z.strictObject({ instanceId: id, entry: id, exit: id })),
  })),
  workloads: z.array(z.strictObject({ id, domain: id, kind: id, from: localRef, to: localRef, request: fields })),
  scenarios: z.array(z.strictObject({ id, members: z.array(z.union([id, z.strictObject({ workload: id, priority: fact.refine(f =>
    typeof f.value === "number" && Number.isSafeInteger(f.value) && !f.conflicts?.some(c => !Number.isSafeInteger(c.value)) && !f.unit && !f.condition, "우선순위에는 단위 없는 정수가 필요합니다") })])) })),
});

// 파일·메모리 입력에서 같은 문서 위치를 오류에 남긴다.
export function parseDocument<T>(schema: z.ZodType<T>, data: unknown, name: string): T {
  const parsed = schema.safeParse(data);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  throw new Error(name + "#" + issue.path.join(".") + " — " + issue.message);
}
