// 시험 전용 영역은 포트 속도와 작업률을 협상하고 내부 엣지가 지나는 자원의 소비를 보고한다.
import { z } from "zod";
import { effectiveClaim, type DomainPlugin, type Verdict } from "../engine/contract.ts";

export function trialDomain(id = "trial", rate = "rate", unit = "회/s"): DomainPlugin {
  const speed = z.strictObject({ value: z.number().nonnegative().nullable(), unit: z.literal(unit) });
  const schema = z.strictObject({ [rate]: speed });
  const names: Record<Verdict, string> = { ok: "성립", conditional: "조건부", unknown: "미확인", impossible: "불가" };
  return {
    id, sources: [{ id: "pulse", title: "합성 펄스 규격", locator: "fixture:pulse-spec" }], params: schema, attributes: z.record(z.string().regex(/^budget:/), speed), request: schema,
    policy({scene, resource, connectedPorts, activeWorkloads}) {
      const r = scene.resources[resource]!;
      const policy = effectiveClaim(scene, "resource", resource, id, "policy")!;
      if (scene.claims[policy]!.value !== "port-table") return null;
      const attached = connectedPorts.filter(p => scene.ports[p]!.item === r.item);
      const connections = scene.connections.filter(c => attached.includes(c.from));
      const connectionFor = (w: number) => connections.find(c => scene.ports[c.to]!.item === scene.nodes[scene.workloads[w]!.to]!.item);
      const evidence = connections.map(c => c.evidence);
      const users = activeWorkloads.flatMap(w => {
        const c = connectionFor(w);
        return c ? [{ workload: w, port: scene.ports[c.from]!.id }] : [];
      });
      const connected = attached.map(p => scene.ports[p]!.id).sort().join("+");
      const active = users.map(u => u.port).sort().join("+");
      const limits = [];
      for (const user of users) {
        const claim = effectiveClaim(scene, "item", r.item, id, ["budget", connected, active, user.port].join(":"));
        if (claim === undefined) return null;
        const limit = scene.claims[claim]!.value;
        if (typeof limit !== "number") return null;
        limits.push({ workload: user.workload, limit, rule: "접속·활성 포트 조합표", inputs: [claim, ...evidence], specs: [] });
      }
      return limits;
    },
    negotiate({ scene, ports }) {
      const inputs: number[] = [];
      const limits: number[] = [];
      for (const port of ports) {
        const entries = scene.interfaces.flatMap((i, row) => i.port === port && i.domain === id ? [{ ...i, row }] : []);
        inputs.push(...entries.map(i => i.evidence));
        const row = entries.find(i => i.protocol === "pulse" && i.role === "bidirectional")?.row;
        if (row === undefined) return [{ mode: "pulse", unit, limit: null, condition: "", verdict: "impossible",
          rule: "양방향 펄스 인터페이스 필요", inputs, specs: ["pulse"] }];
        const claim = effectiveClaim(scene, "interface", row, id, rate)!;
        inputs.push(claim);
        const value = scene.claims[claim]!.value;
        if (typeof value === "number") limits.push(value);
      }
      const known = limits.length === ports.length;
      return [{ mode: "pulse", verdict: known ? "ok" : "unknown", rule: "포트 공통 작업률", condition: "", inputs, specs: ["pulse"],
        limit: known ? Math.min(...limits) : null, unit }];
    },
    demand(scene, workload) {
      const claim = effectiveClaim(scene, "workload", workload, id, rate)!;
      const value = scene.claims[claim]!.value;
      return [{ mode: "pulse", requested: typeof value === "number" ? value : null, unit, preference: 0, elastic: true, via: [],
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
