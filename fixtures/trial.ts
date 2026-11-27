// 시험 전용 영역은 포트 속도와 작업률을 협상하고 내부 엣지가 지나는 자원의 소비를 보고한다.
import { z } from "zod";
import { effectiveClaim, type DomainPlugin, type Verdict } from "../engine/contract.ts";

export function trialDomain(id = "trial", rate = "rate"): DomainPlugin {
  const speed = z.strictObject({ value: z.number().nonnegative().nullable(), unit: z.literal("회/s") });
  const schema = z.strictObject({ [rate]: speed });
  const names: Record<Verdict, string> = { ok: "성립", conditional: "조건부", unknown: "미확인", impossible: "불가" };
  return {
    id, sources: [{ id: "pulse", title: "합성 펄스 규격", locator: "fixture:pulse-spec" }], params: schema, attributes: z.strictObject({}), request: schema,
    negotiate({ scene, ports }) {
      const inputs: number[] = [];
      const limits: number[] = [];
      for (const port of ports) {
        const entries = scene.interfaces.flatMap((i, row) => i.port === port && i.domain === id ? [{ ...i, row }] : []);
        inputs.push(...entries.map(i => i.evidence));
        const row = entries.find(i => i.protocol === "pulse" && i.role === "bidirectional")?.row;
        if (row === undefined) return [{ mode: "pulse", unit: "회/s", limit: null, condition: "", verdict: "impossible",
          rule: "양방향 펄스 인터페이스 필요", inputs, specs: ["pulse"] }];
        const claim = effectiveClaim(scene, "interface", row, id, rate)!;
        inputs.push(claim);
        const value = scene.claims[claim]!.value;
        if (typeof value === "number") limits.push(value);
      }
      const known = limits.length === ports.length;
      return [{ mode: "pulse", verdict: known ? "ok" : "unknown", rule: "포트 공통 작업률", condition: "", inputs, specs: ["pulse"],
        limit: known ? Math.min(...limits) : null, unit: "회/s" }];
    },
    demand(scene, workload) {
      const claim = effectiveClaim(scene, "workload", workload, id, rate)!;
      const value = scene.claims[claim]!.value;
      return [{ mode: "pulse", requested: typeof value === "number" ? value : null, unit: "회/s", preference: 0, elastic: true, via: [],
        rule: "요청 작업률", inputs: [claim], specs: [] }];
    },
    consume(scene, _workload, steps) {
      return steps.flatMap(s => s.kind !== "edge" ? [] : scene.resourceUses.filter(u => u.edge === s.row).map(u => ({
        resource: u.resource, fixed: 0, coefficient: 1, rule: "통과마다 작업률 한 몫", inputs: [u.evidence], specs: ["pulse"],
      })));
    },
    explain(verdict, mode) { return [mode, names[verdict]].filter(Boolean).join(" "); },
    quest(field) { return field + " 값을 확인하세요."; },
  };
}
