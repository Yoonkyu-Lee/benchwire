// 저장장치 복사는 USB 벌크 경로를 따라 매체·발열 한도와 내부 전송 자원을 소비한다.
import { z } from "zod";
import { effectiveClaim, type DomainPlugin } from "../../engine/contract.ts";

const DOMAIN = "storage";
const MODE = "copy";
const UNIT = "MB/s";
const CARRIER = { domain: "data", mode: "bulk" };
const rate = z.strictObject({ value: z.number().nonnegative().nullable(), unit: z.literal(UNIT) });
const reference = z.strictObject({ value: z.string().min(1).nullable(), unit: z.literal("") });
const labels = { ok: "성립", conditional: "조건부", impossible: "불가", unknown: "미확인" };

export const storageDomain: DomainPlugin = {
  id: DOMAIN, resourceUnits: [UNIT],
  sources: [],
  params: z.strictObject({}),
  attributes: z.strictObject({}),
  request: z.strictObject({ throughput: rate, viaInstance: reference.optional(), viaNode: reference.optional() })
    .refine(r => (r.viaInstance === undefined) === (r.viaNode === undefined), {
      path: ["viaNode"], message: "경유 실물 ID와 노드 ID를 함께 지정하세요",
    }),
  negotiate() { return []; },
  demand(scene, workload) {
    const inputs = scene.claims.flatMap((c, row) => c.ownerKind === "workload" && c.owner === workload && c.domain === DOMAIN ? [row] : []);
    const read = (field: string) => {
      const row = effectiveClaim(scene, "workload", workload, DOMAIN, field);
      return row === undefined ? null : scene.claims[row]!.value;
    };
    const rate = read("throughput");
    const waypoints = inputs.some(row => scene.claims[row]!.field === "viaInstance");
    const instance = read("viaInstance"), node = read("viaNode");
    const stop = waypoints ? scene.nodes.findIndex(n => n.id === node && scene.items[n.item]!.id === instance) : -1;
    const missing = waypoints && stop < 0;
    const via = stop < 0 ? [] : [stop];
    return [{ mode: MODE, unit: UNIT, preference: 0, elastic: true, via,
      carriers: [CARRIER, ...via.map(() => CARRIER)],
      requested: !missing && typeof rate === "number" ? rate : null,
      rule: missing ? "복사 경유 노드 미확인" : "복사 요청 처리량", inputs, specs: [] }];
  },
  consume(scene, _workload, steps) {
    return steps.flatMap(step => step.kind !== "edge" ? [] : scene.resourceUses.flatMap(use => {
      if (use.edge !== step.row) return [];
      const resource = scene.resources[use.resource]!;
      if (resource.unit !== UNIT || resource.domain !== DOMAIN && resource.domain !== CARRIER.domain) return [];
      return [{ resource: use.resource, fixed: 0, coefficient: 1,
        rule: "통과할 때마다 복사 처리량만큼 자원 소비", inputs: [use.evidence], specs: [] }];
    }));
  },
  explain(verdict) { return "저장장치 복사 " + labels[verdict]; },
  quest(field) {
    if (field === "capacity") return "매체의 읽기·쓰기나 발열에 따른 처리량 한도를 확인하세요.";
    if (field === "policy") return "이 자원을 동시에 쓰는 복사 작업 사이의 분배 정책을 확인하세요.";
    if (field === "throughput") return "복사 요청량을 MB/s로 확인하세요.";
    if (field === "viaInstance" || field === "viaNode") return "복사가 거쳐야 하는 실물과 노드를 확인하세요.";
    return field + " 값을 확인하세요.";
  },
};
