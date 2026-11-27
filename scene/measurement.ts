// 수동 검증과 수집 관측을 같은 실물·포트 사슬·조건의 측정 한 건으로 기록한다.
import type { z } from "zod";
import { domains, plugins } from "../domains/registry.ts";
import { evaluate } from "../engine/evaluate.ts";
import type { Results } from "../engine/results.ts";
import { connectionPorts, type MeasurementContext, type Scene } from "../engine/scene.ts";
import type { sceneFile } from "./files.ts";

type Document = z.input<typeof sceneFile>;
type Connection = Document["connections"][number];
type Personal = NonNullable<Document["personal"]>[number];
type Source = Document["sources"][number];
type Value = {value:Personal["claim"]["value"]; unit:string};
export type MeasurementTarget = Pick<Personal,"instanceId"|"ownerKind"|"ownerId"|"domain"|"field"> & {condition?:string}
  | {connection:number; domain:string; field:string};

type Prediction = { values: Value["value"][]; low?: number; high?: number; unit: string };
const SOURCE_SCHEME = "verification:";
const decimal = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 3, useGrouping: false });

export function verificationSource(locator: string) {
  return locator.startsWith(SOURCE_SCHEME) ? new URLSearchParams(locator.slice(SOURCE_SCHEME.length)) : undefined;
}

export function verificationLocator(metadata: URLSearchParams) {
  return SOURCE_SCHEME + metadata;
}

function sameContext(recorded: MeasurementContext, current: MeasurementContext, requireKnown = false) {
  return recorded.firmware === current.firmware && recorded.measurementCondition === current.measurementCondition &&
    (!requireKnown || recorded.firmware !== undefined && recorded.measurementCondition !== undefined);
}

// 입력 중인 실물 상태로 바뀌는 개인 주장의 적용 여부만 판정용 복사본에 반영한다.
export function sceneWithMeasurementContext(scene: Scene, current: Document["items"]): Scene {
  const items = scene.items.map((item, row) => {
    const scope = current[row]!;
    return sameContext(item, scope) ? item
      : { ...item, firmware: scope.firmware, measurementCondition: scope.measurementCondition };
  });
  if (items.every((item, row) => item === scene.items[row])) return scene;
  const scoped = { ...scene, items };
  const claims = scene.claims.map(claim => {
    if (claim.scope !== "personal" || claim.inactive === "wiring") return claim;
    const { ownerKind, owner } = claim;
    let applies;
    if (ownerKind === "connection") {
      const ports = connectionPorts(scoped, owner);
      applies = claim.observedPorts!.every((recorded, i) => sameContext(recorded, ports[i]!, true));
    } else {
      const item = ownerKind === "item" ? owner : ownerKind === "port" ? scene.ports[owner]!.item
        : ownerKind === "interface" ? scene.ports[scene.interfaces[owner]!.port]!.item : scene.resources[owner]!.item;
      applies = sameContext(claim, items[item]!) && (claim.firmware === undefined || claim.measurementCondition !== undefined);
    }
    if (applies === !claim.inactive) return claim;
    const updated = { ...claim };
    if (applies) delete updated.inactive;
    else updated.inactive = "measurementCondition";
    return updated;
  });
  return { ...scoped, claims };
}

// 표시에는 이미 계산한 판정을 쓰고 저장할 때는 같은 측정의 기존 관측을 가린 장면을 평가한다.
export function measurementPrediction(scene: Scene, target: MeasurementTarget, unit: string,
  scenario: number | null = scene.scenarios.length ? 0 : null, evaluated?: Results): Prediction {
  const unknown = { values: [], unit };
  const { domain, field } = target;
  if (!("connection" in target)) {
    const { instanceId, ownerKind, ownerId, condition = "" } = target;
    const item = scene.items.findIndex(i => i.id === instanceId);
    const owner = ownerKind === "item" ? item
      : ownerKind === "interface" ? scene.interfaces.findIndex(i => i.id === ownerId && scene.ports[i.port]!.item === item)
      : scene[ownerKind === "port" ? "ports" : "resources"].findIndex(r => r.id === ownerId && r.item === item);
    const matching = scene.claims.map((claim, row) => ({ claim, row })).filter(({ claim }) =>
      claim.scope === "model" && claim.ownerKind === ownerKind && claim.owner === owner &&
      claim.domain === domain && claim.field === field);
    const selected = matching.find(({ claim }) => claim.condition === condition) ?? matching.find(({ claim }) => !claim.condition);
    if (!selected || selected.claim.unit !== unit) return unknown;
    const { claim, row } = selected;
    const values = scene.claimSources.flatMap(s => s.claim === row && s.candidate ? [s.candidate.value] : []);
    if (claim.value !== null) values.unshift(claim.value);
    return { values: [...new Set(values)], unit };
  }
  const observation = domains.find(d => d.plugin.id === domain)?.quests?.find(q => q.field === field)?.observation;
  const convert = observation?.fromLimit;
  if (!convert) return unknown;
  const { connection } = target;
  const result = evaluated ?? evaluate({ ...scene, claims: scene.claims.map(c =>
    c.scope === "personal" && c.ownerKind === "connection" && c.owner === connection && c.domain === domain && c.field === field
      ? { ...c, inactive: "measurementCondition" } : c) }, plugins);
  const candidates = result.outcomes.flatMap((o, row) => o.subjectKind === "connection" && o.subjectRow === connection &&
    o.domain === domain && o.mode === observation.mode && o.option !== undefined &&
    (o.scenario === scenario || o.scenario === null) ? [{ o, row, option: result.options[o.option]! }] : []);
  const selected = candidates.some(({ o }) => o.scenario === scenario) ? candidates.filter(({ o }) => o.scenario === scenario) : candidates;
  if (selected.some(({ option }) => option.observation !== undefined)) return unknown;
  const metrics = new Map(result.metrics.filter(m => m.kind === "limit").map(m => [m.outcome, m]));
  const limits = selected.flatMap(({ row, option }) => {
    const metric = metrics.get(row);
    const low = metric ? metric.low : option.bounds?.low ?? option.limit;
    const high = metric ? metric.high : option.bounds?.high ?? option.limit;
    return low === null || high === null ? [] : [{ low: convert(low), high: convert(high) }];
  });
  if (!limits.length || limits.some(p => p.high === undefined)) return unknown;
  if (limits.every(p => typeof p.low === "number" && typeof p.high === "number"))
    return { values: [], low: Math.min(...limits.map(p => p.low as number)), high: Math.max(...limits.map(p => p.high as number)), unit };
  const values = limits.every(p => p.low === p.high) ? [...new Set(limits.map(p => p.high!))] : [];
  return { values, unit };
}

export function measurementValueText(value: Value["value"], unit: string) {
  return [value === true ? "예" : value === false ? "아니요" : value, unit].filter(part => part !== "" && part !== null).join(" ");
}

export function predictionText({ values, low, high, unit }: Prediction) {
  if (values.length) return values.map(value => measurementValueText(value, unit)).join(" / ");
  if (low === undefined || high === undefined) return "";
  const amount = low === high ? decimal.format(low) : decimal.format(low) + "–" + decimal.format(high);
  return measurementValueText(amount, unit);
}

export const inactiveReason = {
  firmware:"펌웨어 다름", unknownFirmware:"펌웨어 미확인", measurementCondition:"측정 조건 다름",
  unknownMeasurementCondition:"측정 조건 미확인", wiring:"배선 다름",
};

export function measurementPorts(connection: Connection, items: Document["items"]) {
  const chain = [connection.from,...connection.parts.flatMap(p => [
    {instanceId:p.instanceId,id:p.entry},{instanceId:p.instanceId,id:p.exit},
  ]),connection.to];
  return chain.map(({instanceId,id}) => {
    const {firmware,measurementCondition} = items.find(i => i.instanceId === instanceId)!;
    return {instanceId,id,firmware,measurementCondition};
  });
}

// 수동 입력은 기존 값을 수정할 수 있다. 수집 파일은 같은 값에 출처를 보태며 값이 충돌하면 적용을 보류한다.
export function recordMeasurement(saved:Document, target:MeasurementTarget, value:Value, source:Source, via:"manual", prediction?:Prediction): Document;
export function recordMeasurement(saved:Document, target:MeasurementTarget, value:Value, source:Source, via:"capture", prediction?:Prediction): Document | undefined;
export function recordMeasurement(saved:Document, target:MeasurementTarget, value:Value, source:Source, via:"manual"|"capture", prediction?:Prediction) {
  function claim(previous?:Personal["claim"]) {
    const same = previous && previous.value === value.value && (previous.unit ?? "") === value.unit && (via === "manual" || !previous.conflicts?.length);
    if (same && (via === "manual" || previous.sources.includes(source.id))) return previous;
    if (previous && !same && via === "capture") return undefined;
    return {...value,confidence:"user_verified" as const,sources:same ? [...previous.sources,source.id] : [source.id]};
  }
  const expected = prediction && prediction.unit === value.unit ? predictionText(prediction) : "";
  if (expected && prediction) {
    const metadata = verificationSource(source.locator) ?? new URLSearchParams({ note: source.locator });
    metadata.set("prediction", expected);
    const { values, low, high } = prediction;
    const differs = values.length ? !values.includes(value.value)
      : typeof value.value === "number" && low !== undefined && high !== undefined && (value.value < low || value.value > high);
    if (differs) metadata.set("different", "1");
    source = { ...source, locator: verificationLocator(metadata) };
  }
  const sources = saved.sources.some(s => s.id === source.id) ? saved.sources : [...saved.sources,source];
  if ("connection" in target) {
    const {connection,domain,field} = target, original = saved.connections[connection]!;
    const ports = measurementPorts(original,saved.items);
    const rows = original.observations ?? [];
    const at = rows.findIndex(o => o.domain === domain && o.field === field && o.ports.length === ports.length &&
      o.ports.every((p,i) => {
        const current = ports[i]!;
        return p.id === current.id && p.instanceId === current.instanceId && sameContext(p, current);
      }));
    const measured = claim(rows[at]?.claim);
    if (!measured) return undefined;
    if (measured === rows[at]?.claim) return saved;
    const row = {ports,domain,field,claim:measured};
    const observations = at < 0 ? [...rows,row] : rows.with(at,row);
    return {...saved,sources,connections:saved.connections.with(connection,{...original,observations})};
  }
  const {condition="",...owner} = target;
  const current = saved.items.find(i => i.instanceId === owner.instanceId)!;
  const {firmware,measurementCondition} = current;
  const rows = saved.personal ?? [];
  const at = rows.findIndex(p => p.instanceId === owner.instanceId && p.ownerKind === owner.ownerKind && p.ownerId === owner.ownerId &&
    p.domain === owner.domain && p.field === owner.field && (p.claim.condition ?? "") === condition &&
    sameContext(p, current));
  const measured = claim(rows[at]?.claim);
  if (!measured) return undefined;
  if (measured === rows[at]?.claim) return saved;
  const row:Personal = {...owner,firmware,measurementCondition,claim:{...measured,condition}};
  return {...saved,sources,personal:at < 0 ? [...rows,row] : rows.with(at,row)};
}
