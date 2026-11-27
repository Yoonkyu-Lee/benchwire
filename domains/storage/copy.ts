// 저장장치 복사의 처리량 요구와 유향 경로의 매체·전송 자원 소비를 선언한다.
// 포트 한도는 실효 처리량 주장으로 받고, 발열 한도는 무조건 성립하는 처리량 자원으로 받는다.
import { z } from "zod";
import { effectiveClaim, type DomainPlugin } from "../../engine/contract.ts";

const DOMAIN = "storage";
const MODE = "copy";
const UNIT = "MB/s";
const rate = z.strictObject({ value: z.number().nonnegative().nullable(), unit: z.literal(UNIT) });
const reference = z.strictObject({ value: z.string().min(1).nullable(), unit: z.literal("") });
const labels = { ok: "성립", conditional: "조건부", impossible: "불가", unknown: "미확인" };

export const storageDomain: DomainPlugin = {
  id: DOMAIN,
  sources: [],
  params: z.strictObject({ throughput: rate }),
  attributes: z.strictObject({}),
  request: z.strictObject({ throughput: rate, viaInstance: reference.optional(), viaNode: reference.optional() })
    .refine(r => (r.viaInstance === undefined) === (r.viaNode === undefined), {
      path: ["viaNode"], message: "경유 실물 ID와 노드 ID를 함께 지정하세요",
    }),
  negotiate({ scene, ports }) {
    const inputs: number[] = [];
    let limit: number | null = null;
    let missing = false;
    let unsupported = false;
    for (const port of ports) {
      const interfaces = scene.interfaces.filter(i => i.port === port);
      const row = scene.interfaces.findIndex(i => i.port === port && i.domain === DOMAIN &&
        i.protocol === MODE && i.role === "bidirectional");
      if (row < 0) {
        unsupported = true;
        inputs.push(...interfaces.map(i => i.evidence));
        continue;
      }
      inputs.push(scene.interfaces[row]!.evidence);
      const claim = effectiveClaim(scene, "interface", row, DOMAIN, "throughput");
      const value = claim === undefined ? null : scene.claims[claim]!.value;
      if (claim !== undefined) inputs.push(claim);
      if (typeof value === "number") limit = limit === null ? value : Math.min(limit, value);
      else missing = true;
    }
    const common = { mode: MODE, unit: UNIT, condition: "", inputs, specs: [] };
    if (unsupported) return [{ ...common, verdict: "impossible", limit: null, rule: "모든 포트에 양방향 복사 인터페이스 필요" }];
    if (missing && limit !== 0) return [{ ...common, verdict: "unknown", limit: null, rule: "복사 포트의 실효 처리량 미확인" }];
    return [{ ...common, verdict: "ok", limit, rule: "복사 포트의 실효 처리량 중 최솟값" }];
  },
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
    return [{ mode: MODE, unit: UNIT, preference: 0, elastic: true, via: stop < 0 ? [] : [stop],
      requested: !missing && typeof rate === "number" ? rate : null,
      rule: missing ? "복사 경유 노드 미확인" : "복사 요청 처리량", inputs, specs: [] }];
  },
  consume(scene, _workload, steps) {
    return steps.flatMap(step => step.kind !== "edge" ? [] : scene.resourceUses.flatMap(use => {
      if (use.edge !== step.row) return [];
      const resource = scene.resources[use.resource]!;
      if (resource.domain !== DOMAIN || resource.unit !== UNIT) return [];
      return [{ resource: use.resource, fixed: 0, coefficient: 1,
        rule: "통과할 때마다 복사 처리량만큼 자원 소비", inputs: [use.evidence], specs: [] }];
    }));
  },
  explain(verdict) { return "저장장치 복사 " + labels[verdict]; },
  quest(field) {
    if (field === "capacity") return "매체의 읽기·쓰기 속도나 공유 전송 구간의 처리량을 확인하세요.";
    if (field === "policy") return "이 자원을 동시에 쓰는 복사 작업 사이의 분배 정책을 확인하세요.";
    if (field === "throughput") return "복사 요청이나 포트의 실효 처리량을 MB/s로 확인하세요.";
    if (field === "viaInstance" || field === "viaNode") return "복사가 거쳐야 하는 실물과 노드를 확인하세요.";
    return field + " 값을 확인하세요.";
  },
};
