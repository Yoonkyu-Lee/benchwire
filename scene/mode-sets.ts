// 지원 모드 집합을 규격 순서로 읽어 모델·실물 검증·복제에 같은 표기를 쓴다.
import { z } from "zod";
import { canonicalModeSet, type DomainPlugin } from "../engine/contract.ts";
import { canonicalFact, modelFile, parseDocument, type sceneFile } from "./files.ts";

type Model = z.input<typeof modelFile>;
type Interface = Model["ports"][number]["interfaces"][number];
type Fact = Interface["evidence"];
type ModelInstance = z.output<typeof sceneFile>["items"][number];
type Personal = z.output<typeof sceneFile>["personal"][number];

export function modeClaim<T extends Fact>(fact: T, order: readonly string[]): T {
  return canonicalFact(fact, value => typeof value === "string" ? canonicalModeSet(value, order) ?? value : value);
}

function interfaceModeClaim<T extends Fact>(iface: Interface, field: string, fact: T, plugins: readonly DomainPlugin[]) {
  const plugin = plugins.find(p => p.id === iface.domain);
  const schema = plugin?.paramsFor?.(iface.protocol) ?? plugin?.params;
  const property = schema instanceof z.ZodObject ? schema.shape[field] : undefined;
  const order = property instanceof z.ZodType ? property.meta()?.modeOrder : undefined;
  return Array.isArray(order) ? modeClaim(fact, order) : fact;
}

export function parseModelDocument(body: unknown, name: string, plugins: readonly DomainPlugin[]) {
  const model = parseDocument(modelFile, body, name);
  for (const port of model.ports) for (const iface of port.interfaces)
    for (const [field, fact] of Object.entries(iface.params))
      iface.params[field] = interfaceModeClaim(iface, field, fact, plugins);
  return model;
}

export function personalModeClaim(row: Personal, items: ModelInstance[], lookup: (key: string) => Model | undefined,
  plugins: readonly DomainPlugin[]) {
  if (row.ownerKind !== "interface") return row.claim;
  const item = items.find(item => item.instanceId === row.instanceId);
  const model = item && lookup(item.modelId + "@" + item.revision);
  for (const port of model?.ports ?? []) {
    const iface = port.interfaces.find(iface => iface.id === row.ownerId && iface.domain === row.domain);
    if (iface) return interfaceModeClaim(iface, row.field, row.claim, plugins);
  }
  return row.claim;
}
