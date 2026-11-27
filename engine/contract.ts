// 영역은 저장 입력의 모양과 협상·수요·소비 규칙을 선언하고 계산에 읽은 주장 번호를 돌려준다.
import type { Scene } from "./scene.ts";
export { effectiveClaim } from "./scene.ts";
export type { Scene, Claim, Value } from "./scene.ts";

export type Verdict = "ok" | "conditional" | "impossible" | "unknown";
export type Direction = "forward" | "reverse";
export interface Trace { rule: string; inputs: number[]; specs: string[] }
export type KnownVerdict = Exclude<Verdict, "unknown">;
export interface Interval { low: number | null; high: number | null }
export interface Measure extends Interval { kind: string; unit: string }
export interface Pool extends Trace {
  id: string; scope: "direction" | "connection"; unit: string; limit: number | null;
  bounds?: { low: number; high: number };
}
export interface Link {
  scene: Scene; connection: number; direction: Direction;
  // 신호가 지나는 순서대로 양 끝과 사이 부품의 진입·이탈 포트를 담는다.
  ports: number[];
}
export interface Option extends Trace {
  verdict: Verdict; mode: string; limit: number | null; unit: string; condition: string; unused?: number;
  pool?: { domain: string; id: string; perUnit: number };
  // limit가 null일 때 같은 단위의 유한한 0 ≤ low ≤ high를 준다. low는 해당 모드에서 보장한 한도다.
  bounds?: { low: number; high: number };
}
export interface Demand extends Trace {
  // 출발·경유·도착 노드 사이의 구간마다 사용할 운반 서비스다.
  carriers?: readonly { domain: string; mode: string }[];
  mode: string; preference: number; elastic: boolean; via: number[]; requested: number | null; unit: string;
}
export interface Step { kind: "edge" | "connection"; row: number; from: number; to: number; direction: Direction; option: number | null }
export interface Consumption extends Trace { resource: number; fixed: number; coefficient: number }
export interface InputSchema {
  safeParse(input: unknown): { success: true } | { success: false; error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } };
}
export interface PolicyContext {
  scene: Scene; resource: number; connectedPorts: readonly number[]; activeWorkloads: readonly number[];
}
// limit는 해당 자원 단위의 작업별 사용 상한이다. 적용할 표가 없으면 null을 돌려준다.
export interface PolicyLimit extends Trace { workload: number; limit: number }
export interface DomainPlugin {
  pools?(link: Link): readonly Pool[];
  match?(link: Link, option: Option, demand: Demand, workload: number): Trace & { verdict: Verdict };
  assess?(scene: Scene, workload: number, demand: Demand, steps: readonly Step[], delivered: Interval):
    Trace & { possible: readonly KnownVerdict[]; metrics: readonly Measure[] };
  policy?(context: PolicyContext): PolicyLimit[] | null;
  id: string;
  sources: readonly { id: string; title: string; locator: string }[];
  // 각 스키마는 필드 이름을 키로, {value, unit}을 값으로 받는다. null은 미확인이다.
  resourceUnits?: readonly string[];
  paramsFor?(protocol: string): InputSchema | undefined;
  params: InputSchema; attributes: InputSchema; request: InputSchema;
  negotiate(link: Link): Option[];
  demand(scene: Scene, workload: number): Demand[];
  // 엔진이 운반 서비스와 공용 예산을 계산하고, 영역은 장비 내부의 추가 소비를 돌려준다.
  // 고정 수요의 계수는 엔진이 계수 × 요청량으로 바꿔 예약한다.
  consume(scene: Scene, workload: number, steps: readonly Step[], demand: Demand, options: readonly Option[]): Consumption[];
  explain(verdict: Verdict, mode: string): string;
  quest(field: string): string;
}
