// 영역은 저장 입력의 모양과 협상·수요·소비 규칙을 선언하고 계산에 읽은 주장 번호를 돌려준다.
import type { Claim, Scene, Value } from "./scene.ts";
export { effectiveClaim, readClaim, hasClaimPrefix } from "./scene.ts";
export type { Scene, Claim, Value, MeasurementContext } from "./scene.ts";

export type Verdict = "ok" | "conditional" | "impossible" | "unknown";
export type Direction = "forward" | "reverse";
export interface Trace { rule: string; inputs: number[]; specs: string[] }
export type KnownVerdict = Exclude<Verdict, "unknown">;
export interface Interval { low: number | null; high: number | null }
// inputs는 이 지표의 low~high가 실제로 반영한 주장이다. 판정 전체의 인용은 Trace에 둔다.
export interface Measure extends Interval { kind: string; unit: string; inputs?: readonly number[] }

// 단위 환산과 배분의 연산 반올림을 흡수한다.
const RELATIVE_TOLERANCE = 16 * Number.EPSILON;
// 큰 두 값을 뺀 작은 잔량에는 원래 값의 반올림이 남는다. 10⁻¹²는 규격 걸음·실측 정밀도보다 작다.
const ABSOLUTE_TOLERANCE = 1e-12;
export function compareQuantity(a: number, b: number) {
  if (a === b) return 0;
  const difference = a - b;
  const tolerance = Math.max(ABSOLUTE_TOLERANCE, RELATIVE_TOLERANCE * Math.max(Math.abs(a),Math.abs(b)));
  if (Number.isFinite(difference) && Math.abs(difference) <= tolerance) return 0;
  return Math.sign(difference);
}

export interface Choice extends Trace { connection: number; profile: string; domain: string }
export type LoadTarget = { resource: number; possible?: boolean } | { connection: number; direction: Direction; domain: string; mode: string };
export type StandingLoad = Trace & { item: number; id: string; amount: number | null; unit: string } & (
  | { targets: readonly LoadTarget[] }
  | { feed: { inputPort: number; mode: string; sources: readonly (Trace & { node: number; outputPort?: number; possible?: boolean })[] } });
export type FeedLoad = Extract<StandingLoad, { feed: unknown }>;
export interface Pool extends Trace {
  id: string; scope: "direction" | "connection"; unit: string; limit: number | null;
  bounds?: { low: number; high: number };
}
// 연결 설정 제공자가 대상 서비스에 남기는 레인 수다. 생략한 설정에서는 서비스 고유의 한도를 쓴다.
export interface LaneProfile { domain: string; mode: string; profile: string; maxLanes?: number; inputs: number[] }
export interface Link {
  scene: Scene; connection: number; direction: Direction;
  // 신호가 지나는 순서대로 양 끝과 사이 부품의 진입·이탈 포트를 담는다.
  ports: number[];
  // 같은 서비스·설정의 레인 한도는 각각 유지하고, 주장 행은 제공자 전체에서 모은다.
  laneProfiles?: readonly LaneProfile[];
}
export interface Option extends Trace {
  verdict: Verdict; mode: string; limit: number | null; unit: string; condition: string; unused?: number;
  // 한 배선에서 실제 관측한 서비스의 주장 행이다. 설정 태그가 있으면 그 서비스와 함께 쓸 수 있는 설정만 남긴다.
  observation?: number;
  profile?: string;
  pool?: { domain: string; id: string; perUnit: number };
  // limit가 null일 때 같은 단위의 유한한 0 ≤ low ≤ high를 준다. low는 해당 모드에서 보장한 한도다.
  bounds?: { low: number; high: number };
}
export interface Carrier {
  domain: string; mode: string;
  // 작업의 수요 한 단위가 쓰는 운반 서비스의 단위와 양이다. 생략하면 같은 단위다.
  conversion?: { unit: string; perUnit: number };
}
export interface Demand extends Trace {
  // 출발·경유·도착 노드 사이의 구간마다 사용할 운반 서비스다.
  carriers?: readonly Carrier[];
  mode: string; preference: number; elastic: boolean; via: number[]; requested: number | null; unit: string;
}
export interface Step { kind: "edge" | "connection"; row: number; from: number; to: number; direction: Direction; option: number | null }
// 고정 예약을 구간으로만 알면 fixed가 하한, fixedHigh가 그 자원에서 소비할 수 있는 상한이다.
export interface Consumption extends Trace { resource: number; fixed: number; fixedHigh?: number; coefficient: number }
export interface InputSchema {
  safeParse(input: unknown): { success: true } | { success: false; error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } };
}
export interface PolicyContext {
  scene: Scene; resource: number; connectedPorts: readonly number[]; activeWorkloads: readonly number[];
}
// limit는 해당 자원 단위의 작업별 사용 상한이다. 적용할 표가 없으면 null을 돌려준다.
export interface PolicyLimit extends Trace { workload: number; limit: number | null }
export interface DomainPlugin {
  laneProfiles?(link: Link): readonly LaneProfile[];
  // assess가 보고하는 영역 고유 지표다. delivery는 엔진이 계산하는 내장 전달량에 예약한다.
  goalMeasures?: readonly { kind: string; unit: string; label: string }[];
  // 소유 대상에 관계없이 유효한 미확인 주장의 이산 후보를 준다. 참조 필드는 파일의 지역 ID를 쓴다.
  profileValues?(claim: Claim, topology: Pick<Scene,"interfaces" | "ports" | "resources" | "nodes">): readonly Exclude<Value, null>[];
  standingLoads?(scene: Scene): readonly StandingLoad[];
  pools?(link: Link): readonly Pool[];
  match?(link: Link, option: Option, demand: Demand, workload: number): Trace & { verdict: Verdict };
  assess?(scene: Scene, workload: number, demand: Demand, steps: readonly Step[], delivered: Interval):
    Trace & { possible: readonly KnownVerdict[]; metrics: readonly Measure[] };
  policy?(context: PolicyContext): PolicyLimit[] | null;
  id: string;
  sources: readonly { id: string; title: string; locator: string }[];
  // 각 스키마는 필드 이름을 키로, {value, unit}을 값으로 받는다. null은 미확인이다.
  resourceUnits?: readonly string[];
  // 한 관측 행의 { [필드]: { value, unit } }를 검증한다. 각 필드를 독립적으로 입력할 수 있어야 한다.
  observations?: InputSchema;
  paramsFor?(protocol: string): InputSchema | undefined;
  // 해당 송수신 역할에서 빠진 모델 필드를 지정한 단위의 미확인 주장으로 복원한다.
  requiredParams?(protocol: string, role: string): Readonly<Record<string,string>> | undefined;
  // 속성이 필요한 모델과 필드별 단위. 연결 프로토콜은 부품을 끼운 배선의 양 끝에 공통으로 선언된 것만 준다.
  requiredAttributes?(context: { kind: string; protocols: ReadonlySet<string>; linkedProtocols: ReadonlySet<string>;
    hasAttributes: boolean }): Readonly<Record<string, string>> | undefined;
  params: InputSchema; attributes: InputSchema; request: InputSchema;
  negotiate(link: Link): Option[];
  demand(scene: Scene, workload: number): Demand[];
  // 엔진이 운반 서비스와 공용 예산을 계산하고, 영역은 장비 내부의 추가 소비를 돌려준다.
  // 고정 수요의 계수는 엔진이 계수 × 요청량으로 바꿔 예약한다.
  consume(scene: Scene, workload: number, steps: readonly Step[], demand: Demand, options: readonly Option[]): Consumption[];
  explain(verdict: Verdict, mode: string): string;
  quest(field: string): string;
}
