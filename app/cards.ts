// 모델과 유효한 실물 검증값에서 카드에 표시할 대표 스탯과 신뢰도를 읽는다.
import { domains } from "../domains/registry.ts";
import type { Claim, Scene } from "../engine/scene.ts";
import type { Model } from "./document.ts";
import { quantity } from "./results.ts";

type Fact = Model["ports"][number]["connector"];
const confidenceText: Record<Fact["confidence"], string> = {
  official: "공식", review: "리뷰", community: "커뮤니티", user_verified: "내가 검증", inferred: "추정", unknown: "미확인",
};
const MAX_CARD_STATS = 2;
const selectors = domains.flatMap(({ plugin, cardStats }) => (cardStats ?? []).map(rule => ({ ...rule, domain: plugin.id })));
const key = (scope: string, id: string, domain: string, field: string) => JSON.stringify([scope, id, domain, field]);

export type CardMeasurements = ReadonlyMap<string, ReadonlyMap<string, Claim>>;
export function cardMeasurements(scene: Scene): CardMeasurements {
  const items = new Map<string, Map<string, Claim>>();
  for (const claim of scene.claims) {
    if (claim.scope !== "personal" || claim.inactive || claim.condition || claim.value === null) continue;
    const { ownerKind, owner, domain, field } = claim;
    const resource = ownerKind === "resource" ? scene.resources[owner] : undefined;
    const iface = ownerKind === "interface" ? scene.interfaces[owner] : undefined;
    const item = ownerKind === "item" ? owner : resource?.item ?? (iface && scene.ports[iface.port]!.item);
    if (item === undefined) continue;
    const id = scene.items[item]!.id;
    const facts = items.get(id) ?? new Map<string, Claim>();
    const slot = key(ownerKind, resource?.id ?? iface?.id ?? "", domain, field);
    if (!facts.has(slot)) facts.set(slot, claim);
    items.set(id, facts);
  }
  return items;
}

type Stat = { label: string; slot: string; fact: Fact };
const cached = new WeakMap<Model, Stat[]>();
function modelStats(model: Model) {
  const before = cached.get(model);
  if (before) return before;
  const stats: Stat[] = [];
  const interfaces = model.ports.flatMap(port => port.interfaces);
  for (const { domain, scope, field, label, unit, resourceKind } of selectors) {
    const iface = scope === "interface" ? interfaces.find(row => row.domain === domain && row.params[field]) : undefined;
    const resource = scope === "resource" ? model.resources.find(row =>
      row.domain === domain && (unit === undefined || row.unit === unit) && (resourceKind === undefined || row.kind === resourceKind)) : undefined;
    const fact = scope === "item" ? model.attributes?.[domain]?.[field] : iface?.params[field]
      ?? (field === "capacity" ? resource?.capacity : field === "policy" ? resource?.policy : undefined);
    if (!fact) continue;
    const slot = key(scope, iface?.id ?? resource?.id ?? "", domain, field);
    if (!stats.some(row => row.slot === slot)) stats.push({ label, slot, fact });
    if (stats.length === MAX_CARD_STATS) break;
  }
  cached.set(model, stats);
  return stats;
}

function format(value: Fact["value"], unit = "") {
  return typeof value === "number" || value === null ? quantity(value, unit)
    : [typeof value === "boolean" ? value ? "예" : "아니요" : value, unit].filter(Boolean).join(" ");
}

export function cardRows(model: Model, personal?: ReadonlyMap<string, Claim>) {
  return modelStats(model).map(({ label, slot, fact }) => {
    const measured = personal?.get(slot);
    const conflict = Boolean(fact.conflicts?.length);
    const candidates = conflict ? [fact, ...fact.conflicts!].map(row => format(row.value, fact.unit)) : [];
    const value = measured ? format(measured.value, measured.unit) : conflict ? candidates.join(" / ") : format(fact.value, fact.unit);
    const confidence = measured?.confidence ?? (conflict || fact.value === null ? "unknown" : fact.confidence);
    const condition = measured?.condition || fact.condition;
    return { label, value, confidence, badge: confidenceText[confidence], conflict,
      title: [label + " " + value, confidenceText[confidence], conflict && "충돌 " + candidates.join(" · "), condition].filter(Boolean).join(" · ") };
  });
}

export function inventoryStats(model: Model, personal?: ReadonlyMap<string, Claim>) {
  const list = document.createElement("div");
  list.className = "inventory-stats";
  for (const stat of cardRows(model, personal)) {
    const row = document.createElement("div");
    row.className = "card-stat";
    row.title = stat.title;
    const text = document.createElement("span");
    text.className = "card-stat-text";
    text.textContent = stat.label + " " + stat.value;
    const badge = document.createElement("span");
    badge.className = "confidence-badge";
    badge.dataset.confidence = stat.confidence;
    badge.textContent = stat.badge;
    row.append(text, badge);
    if (stat.conflict) {
      const conflict = document.createElement("span");
      conflict.className = "conflict-badge";
      conflict.textContent = "충돌";
      row.append(conflict);
    }
    list.append(row);
  }
  return list;
}
