// 영역은 저장 입력의 모양과 협상·수요·소비 규칙을 선언하고 계산에 읽은 주장 번호를 돌려준다.
import type { Scene } from "./scene.ts";
export { effectiveClaim } from "./scene.ts";
export type { Scene, Claim, Value } from "./scene.ts";

export type Verdict = "ok" | "conditional" | "impossible" | "unknown";
export type Direction = "forward" | "reverse";
export interface Trace { rule: string; inputs: number[]; specs: string[] }
export interface Link {
  scene: Scene; connection: number; direction: Direction;
  // 신호가 지나는 순서대로 양 끝과 사이 부품의 진입·이탈 포트를 담는다.
  ports: number[];
}
export interface Option extends Trace {
  verdict: Verdict; mode: string; limit: number | null; unit: string; condition: string; unused?: number;
  // limit가 null일 때 같은 단위의 유한한 0 ≤ low ≤ high를 준다. low는 해당 모드에서 보장한 한도다.
  bounds?: { low: number; high: number };
}
export interface Demand extends Trace {
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
  policy?(context: PolicyContext): PolicyLimit[] | null;
  id: string;
  sources: readonly { id: string; title: string; locator: string }[];
  // 각 스키마는 필드 이름을 키로, {value, unit}을 값으로 받는다. null은 미확인이다.
  resourceUnits?: readonly string[];
  paramsFor?(protocol: string): InputSchema | undefined;
  params: InputSchema; attributes: InputSchema; request: InputSchema;
  negotiate(link: Link): Option[];
  demand(scene: Scene, workload: number): Demand[];
  // 협상 한도는 엔진이 방향·영역별로 공유한다. 영역을 가로지르는 터널은 플러그인이 명시적 자원을 소비한다.
  // 고정 수요의 계수는 엔진이 계수 × 요청량으로 바꿔 예약한다.
  consume(scene: Scene, workload: number, steps: readonly Step[], demand: Demand, options: readonly Option[]): Consumption[];
  explain(verdict: Verdict, mode: string): string;
  quest(field: string): string;
}
