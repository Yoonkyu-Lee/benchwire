// 동시 사용 자원 표를 소유 카드의 사용률과 근거 선택으로 바꾼다.
import { quantity, type ResultView } from "./results.ts";

export interface HeatMark { row: number; label: string; caption: string; usage: number | null; bottleneck: boolean }
export function heatmap(view: ResultView) {
  const cards = new Map<string, HeatMark[]>();
  const bottlenecks = new Set(view.result.bindings.filter(binding =>
    binding.scenario === view.scenario && binding.run === "together" && binding.resourceKind === "scene").map(binding => binding.resource));
  view.resources.forEach(({ resourceKind, resource, label, used, capacity, unit, basis }, row) => {
    if (resourceKind !== "scene") return;
    const item = view.scene.items[view.scene.resources[resource]!.item]!.id;
    const usage = used === null || capacity === null ? null : capacity > 0 ? used / capacity : used > 0 ? 1 : 0;
    const caption = usage === null ? "?" : Math.round(usage * 100) + "%";
    const marks = cards.get(item) ?? [];
    const bottleneck = bottlenecks.has(resource);
    marks.push({ row, usage, caption, bottleneck,
      label: [label, usage === null ? "사용률 미확인" : caption, quantity(used, unit) + " / " + quantity(capacity, unit),
        basis === "assumed" && "가정", bottleneck && "병목"].filter(Boolean).join(" · ") });
    cards.set(item, marks);
  });
  return cards;
}
