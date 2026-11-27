// 수동 검증과 수집 관측을 같은 실물·포트 사슬·조건의 측정 한 건으로 기록한다.
import type { z } from "zod";
import type { sceneFile } from "./files.ts";

type Document = z.input<typeof sceneFile>;
type Connection = Document["connections"][number];
type Personal = NonNullable<Document["personal"]>[number];
type Source = Document["sources"][number];
type Value = {value:Personal["claim"]["value"]; unit:string};
export type MeasurementTarget = Pick<Personal,"instanceId"|"ownerKind"|"ownerId"|"domain"|"field"> & {condition?:string}
  | {connection:number; domain:string; field:string};

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
export function recordMeasurement(saved:Document, target:MeasurementTarget, value:Value, source:Source, via:"manual"): Document;
export function recordMeasurement(saved:Document, target:MeasurementTarget, value:Value, source:Source, via:"capture"): Document | undefined;
export function recordMeasurement(saved:Document, target:MeasurementTarget, value:Value, source:Source, via:"manual"|"capture") {
  function claim(previous?:Personal["claim"]) {
    const same = previous && previous.value === value.value && (previous.unit ?? "") === value.unit && (via === "manual" || !previous.conflicts?.length);
    if (same && (via === "manual" || previous.sources.includes(source.id))) return previous;
    if (previous && !same && via === "capture") return undefined;
    return {...value,confidence:"user_verified" as const,sources:same ? [...previous.sources,source.id] : [source.id]};
  }
  const sources = saved.sources.some(s => s.id === source.id) ? saved.sources : [...saved.sources,source];
  if ("connection" in target) {
    const {connection,domain,field} = target, original = saved.connections[connection]!;
    const ports = measurementPorts(original,saved.items);
    const rows = original.observations ?? [];
    const at = rows.findIndex(o => o.domain === domain && o.field === field && o.ports.length === ports.length &&
      o.ports.every((p,i) => {
        const current = ports[i]!;
        return p.id === current.id && p.instanceId === current.instanceId &&
          p.firmware === current.firmware && p.measurementCondition === current.measurementCondition;
      }));
    const measured = claim(rows[at]?.claim);
    if (!measured) return undefined;
    if (measured === rows[at]?.claim) return saved;
    const row = {ports,domain,field,claim:measured};
    const observations = at < 0 ? [...rows,row] : rows.with(at,row);
    return {...saved,sources,connections:saved.connections.with(connection,{...original,observations})};
  }
  const {condition="",...owner} = target;
  const {firmware,measurementCondition} = saved.items.find(i => i.instanceId === owner.instanceId)!;
  const rows = saved.personal ?? [];
  const at = rows.findIndex(p => p.instanceId === owner.instanceId && p.ownerKind === owner.ownerKind && p.ownerId === owner.ownerId &&
    p.domain === owner.domain && p.field === owner.field && (p.claim.condition ?? "") === condition &&
    p.firmware === firmware && p.measurementCondition === measurementCondition);
  const measured = claim(rows[at]?.claim);
  if (!measured) return undefined;
  if (measured === rows[at]?.claim) return saved;
  const row:Personal = {...owner,firmware,measurementCondition,claim:{...measured,condition}};
  return {...saved,sources,personal:at < 0 ? [...rows,row] : rows.with(at,row)};
}
