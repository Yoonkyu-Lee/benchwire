// 판정 결과와 중간 계산을 번호로 연결해 출력에서 입력 주장까지 되짚는다.
import type { Carrier, Choice, Demand, Direction, KnownVerdict, Measure, Option, Pool, Step, Trace, Verdict } from "./contract.ts";

export type Run = "solo" | "together";
export type Target = "demand" | "workload" | "connection" | "edge" | "port" | "resource" | "linkResource";
export interface PhysicalStep {
  connection: number; direction: Direction; order: number; entry: number; exit: number;
  kind: "mate" | "part"; verdict: Verdict; required: string; passages: number[][]; truncated: boolean; inputs: number[];
}
export interface Results {
  reservations: { scenario: number; workload: number }[];
  choices: (Choice & { scenario: number })[];
  searches: { scenario: number; examined: number; truncated: boolean }[];
  standingErrors: { domain: string; item: number; id: string; field: string }[];
  standingLoads: (Trace & { item: number; id: string; domain: string; amount: number | null; bounds?: { low: number; high: number }; unit: string;
    kind: "scene" | "link"; resource: number })[];
  physical: PhysicalStep[];
  linkResources: { connection: number; domain: string; direction: Direction; absentDomain: number[]; pool?: Pool; service?: { mode?: string; unit: string; poolResource?: number } }[];
  errors: { domain: string; spec: string; field?: string; resource?: number; stage: "negotiate" | "demand" | "consume"; row: number }[];
  possibleVerdicts: { outcome: number; verdict: Verdict }[];
  quests: { outcome: number; claim: number; instruction: string; impact?: "range" | "verdict" }[];
  rangeInputs: { outcome: number; claim: number }[];
  profileWorlds: { world: number; claim: number; value: string | number | boolean }[];
  wirings: { world: number; claim: number; node: number }[];
  specSources: { domain: string; id: string; title: string; locator: string }[];
  reasonSpecs: { reason: number; source: number }[];
  assessments: { outcome: number; run: Run; verdict: KnownVerdict }[];
  measures: (Measure & { outcome: number; run: Run })[];
  options: (Option & { effective?: true; poolResource?: number; serviceResource?: number; linkResource: number; connection: number; domain: string; direction: Direction })[];
  demands: (Demand & { workload: number })[];
  paths: { workload: number; demand: number; verdict: Verdict; bestCase?: Verdict; conditioned?: boolean; disconnected?: number[]; disconnectedEdges?: number[]; key: string; truncated: boolean }[];
  matches: (Trace & { demand: number; option: number; verdict: Verdict })[];
  steps: (Step & { carrier?: Carrier; path: number; order: number })[];
  resourceUsage: { scenario: number; resourceKind: "scene" | "link"; resource: number; unit: string;
    used: number | null; capacity: number | null; capacityClaim?: number; basis: "calculated" | "assumed"; reasonRows: number[] }[];
  allocations: { scenario: number; workload: number; run: Run; value: number | null; unit: string }[];
  bindings: { scenario: number; workload: number; run: Run; resourceKind: "scene" | "link"; resource: number }[];
  outcomes: { subjectKind: "connection" | "workload"; subjectRow: number; option?: number; path: number | null; soloPath?: number; direction: Direction | null; scenario: number | null; domain: string; unit?: string; pool?: { domain: string; id: string }; verdict: Verdict; mode: string; label: string }[];
  metrics: { outcome: number; kind: "solo" | "together" | "drop" | "dropPercent" | "unused" | "limit"; unit: string;
    range?: "witnessed" | "conservative"; lowWorld?: number; highWorld?: number;
    value: number | null; low: number | null; high: number | null; basis: "calculated" | "assumed" }[];
  reasons: { outcome: number; run?: Run; stage: "physical" | "negotiate" | "path" | "allocate" | "judge"; rule: string; targetKind: Target; targetRow: number }[];
  reasonInputs: { reason: number; claim: number }[];
  reasonParents: { reason: number; prior: number }[];
  needs: { outcome: number; requiredCapability: string }[];
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
export function checkedTrace<T extends Trace>(result: Results, domain: string, stage: Results["errors"][number]["stage"], row: number, trace: T, resource?: number): T {
  const specs = trace.specs.filter(id => result.specSources.some(s => s.domain === domain && s.id === id));
  if (specs.length === trace.specs.length) return trace;
  for (const spec of new Set(trace.specs.filter(id => !specs.includes(id)))) {
    if (!result.errors.some(e => e.domain === domain && e.spec === spec && e.stage === stage && e.row === row && e.resource === resource))
      result.errors.push({ domain, spec, stage, row, ...(resource === undefined ? {} : { resource }) });
  }
  return { ...trace, specs };
}

// 영역 경계에서 유한한 수량만 받는다. 오류 행의 field는 플러그인이 반환한 필드를 가리킨다.
export function checkedQuantity(result: Results, domain: string, stage: Results["errors"][number]["stage"],
  row: number, field: string, value: number | null, resource?: number) {
  if (value === null || Number.isFinite(value)) return value;
  if (!result.errors.some(e => e.domain === domain && e.stage === stage && e.row === row && e.field === field && e.resource === resource))
    result.errors.push({ domain, stage, row, field, spec: "", ...(resource === undefined ? {} : { resource }) });
  return null;
}
