// 판정 결과와 중간 계산을 번호로 연결해 출력에서 입력 주장까지 되짚는다.
import type { Carrier, Choice, Demand, Direction, DomainPlugin, KnownVerdict, Measure, Option, Pool, Step, Trace, Verdict } from "./contract.ts";
import type { ClaimUse } from "./scene.ts";
import type { HookRead } from "./hook-reads.ts";

export type Run = "solo" | "together";
export type GoalVerdict = "ok" | "impossible" | "unknown";
export type Target = "demand" | "workload" | "connection" | "edge" | "port" | "resource" | "linkResource";
// 계약 오류의 행 번호가 가리키는 표. 탄력 배분의 단위 충돌은 단일 플러그인 호출에 귀속되지 않는다.
const errorTarget = {
  negotiate:"linkResource", pools:"linkResource", demand:"workload", match:"workload", assess:"workload", consume:"path", policy:"path",
} as const satisfies Partial<Record<keyof DomainPlugin,"linkResource" | "workload" | "path">>;
type EntryPoint = keyof typeof errorTarget;
export interface PhysicalStep {
  connection: number; direction: Direction; order: number; entry: number; exit: number;
  kind: "mate" | "part"; verdict: Verdict; required: string; passages: number[][]; truncated: boolean; inputs: number[];
}
export interface Results {
  // 미확인 세계를 찾는 동안 훅의 실제 조회와 선택·배분에서의 용도를 기록한다.
  readClaims?: ClaimUse[];
  hookReads?: HookRead[];
  // 공급 순서별로 더해 둔 총예약이다. 부하별 최댓값을 더하면 같은 예산이 중복될 수 있다.
  feedTotals?: {resource:number;low:number;high:number|null}[];
  // 사용자가 같은 예산들을 모두 지나면 양의 전달량에 앞서 충족돼야 하는 내부 부하들이다.
  feedRequirements?: {resource:number; option?:number; amount:number; capacity:number}[][];
  goals: { id: string; scenario: number; verdict: GoalVerdict; combined: boolean; truncated: boolean;
    // 빈 limitClaims는 특정 미확인 주장 없이 계획·경로 조합이 상한을 넘은 경우다.
    limitClaims?: number[]; openClaims?: number[] }[];
  goalEvidence: { goal: number; workload: number; outcome: number; verdict: GoalVerdict; low: number | null; high: number | null;
    connections: number[]; portVisits?: {connection: number; port: number}[]; reasons: number[]; claims: number[]; issue?: "notMember" }[];
  goalWitnesses: {goal: number; world: number; workload: number; high: number | null;
    assignments: {claim: number; value: string | number | boolean}[]}[];
  // 조건부 추천이 같은 세계에서 목표 전체가 달성됐음을 재현할 수 있게 첫 사례를 남긴다.
  goalSuccesses?: {goal: number; assignments: {claim: number; value: string | number | boolean}[]}[];
  reservations: { scenario: number; workload: number }[];
  choices: (Choice & { scenario: number })[];
  searches: { scenario: number; examined: number; truncated: boolean }[];
  standingErrors: { domain: string; item: number; id: string; field: string }[];
  standingLoads: (Trace & { item: number; id: string; domain: string; amount: number | null; bounds?: { low: number; high: number }; unit: string;
    kind: "scene" | "link"; resource: number; scenario?: number })[];
  physical: PhysicalStep[];
  linkResources: { connection: number; domain: string; direction: Direction; declarationClaimsOnPortsWithoutDomain: number[]; pool?: Pool; service?: { mode?: string; unit: string; poolResource?: number } }[];
  errors: { domain: string; spec: string; field?: string; resource?: number; entryPoint: EntryPoint | null; targetKind: typeof errorTarget[EntryPoint]; row: number }[];
  possibleVerdicts: { outcome: number; verdict: Verdict }[];
  quests: { outcome: number; claim: number; instruction: string; impact?: "range" | "verdict" }[];
  rangeInputs: { outcome: number; claim: number; deliveryRuns?: Run[] }[];
  profileWorlds: { world: number; claim: number; value: string | number | boolean }[];
  wirings: { world: number; claim: number; node: number }[];
  specSources: { domain: string; id: string; title: string; locator: string }[];
  reasonSpecs: { reason: number; source: number }[];
  assessments: { outcome: number; run: Run; verdict: KnownVerdict }[];
  measures: (Measure & { outcome: number; run: Run })[];
  options: (Option & { effective?: true; poolResource?: number; serviceResource?: number; linkResource: number; connection: number; domain: string; direction: Direction })[];
  demands: (Demand & { workload: number })[];
  paths: { workload: number; demand: number; verdict: Verdict; bestCase?: Verdict; worstCase?: Verdict; conditioned?: boolean; disconnected?: number[]; disconnectedEdges?: number[]; key: string; truncated: boolean }[];
  matches: (Trace & { demand: number; option: number; verdict: Verdict })[];
  steps: (Step & { carrier?: Carrier; path: number; order: number })[];
  resourceUsage: { scenario: number; resourceKind: "scene" | "link"; resource: number; unit: string;
    used: number | null; capacity: number | null; capacityClaim?: number; basis: "calculated" | "assumed"; reasonRows: number[] }[];
  allocations: { scenario: number; workload: number; run: Run; value: number | null; unit: string }[];
  bindings: { scenario: number; workload: number; run: Run; resourceKind: "scene" | "link"; resource: number }[];
  outcomes: { conservative?: { cause:"open"|"limit"; claims:number[] }; subjectKind: "connection" | "workload"; subjectRow: number; option?: number; path: number | null; soloPath?: number; possiblePaths?: number[]; direction: Direction | null; scenario: number | null; domain: string; unit?: string; pool?: { domain: string; id: string }; verdict: Verdict; mode: string; label: string }[];
  metrics: { outcome: number; kind: "solo" | "together" | "drop" | "dropPercent" | "unused" | "limit"; unit: string;
    range?: "witnessed" | "conservative"; lowWorld?: number; highWorld?: number;
    value: number | null; low: number | null; high: number | null; basis: "calculated" | "assumed" }[];
  reasons: { outcome: number; run?: Run; profile?: string; stage: "physical" | "negotiate" | "path" | "allocate" | "judge"; rule: string; targetKind: Target; targetRow: number }[];
  reasonInputs: { reason: number; claim: number }[];
  reasonParents: { reason: number; prior: number }[];
  needs: { outcome: number; requiredCapability: string; conditional?:true }[];
  // 같은 결합 요구 집합은 한 번만 기록한다. size에는 요구가 없는 후보도 포함된다.
  needCases?: { size:number; members:{ set:number; connection:number; capability:string }[] };
  incompleteNeeds?: number[];
}
export function addReason(result: Results, reason: Results["reasons"][number], inputs: readonly number[], parents: readonly number[] = [], domain = "", specs: readonly string[] = []) {
  const row = result.reasons.push(reason) - 1;
  for (const claim of new Set(inputs)) result.reasonInputs.push({ reason: row, claim });
  for (const prior of new Set(parents)) result.reasonParents.push({ reason: row, prior });
  for (const id of new Set(specs)) {
    const source = result.specSources.findIndex(s => s.domain === domain && s.id === id);
    result.reasonSpecs.push({ reason: row, source });
  }
  return row;
}

// 계약 위반은 호출한 링크 자원·워크로드·경로를 가리킨다. 유효한 규격은 그대로 추적한다.
export function checkedTrace<T extends Trace>(result: Results, domain: string, entryPoint: EntryPoint, row: number, trace: T, resource?: number): T {
  const specs = trace.specs.filter(id => result.specSources.some(s => s.domain === domain && s.id === id));
  if (specs.length === trace.specs.length) return trace;
  for (const spec of new Set(trace.specs.filter(id => !specs.includes(id)))) {
    if (!result.errors.some(e => e.domain === domain && e.spec === spec && e.entryPoint === entryPoint && e.row === row && e.resource === resource))
      result.errors.push({ domain, spec, entryPoint, targetKind: errorTarget[entryPoint], row, ...(resource === undefined ? {} : { resource }) });
  }
  return { ...trace, specs };
}

// 영역 경계에서 유한한 수량만 받는다. 오류 행의 field는 플러그인이 반환한 필드를 가리킨다.
export function checkedQuantity(result: Results, domain: string, entryPoint: EntryPoint,
  row: number, field: string, value: number | null, resource?: number) {
  if (value === null || Number.isFinite(value)) return value;
  if (!result.errors.some(e => e.domain === domain && e.entryPoint === entryPoint && e.row === row && e.field === field && e.resource === resource))
    result.errors.push({ domain, entryPoint, targetKind: errorTarget[entryPoint], row, field, spec: "", ...(resource === undefined ? {} : { resource }) });
  return null;
}
