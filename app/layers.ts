// 결과 표시와 독립인 영역 이름, 레이어 토글과 초기 배선 분류를 제공한다.
import type { Port } from "./document.ts";

const labels = {
  display: "영상", data: "데이터", storage: "저장", network: "네트워크", power: "전력",
} as const;
export type Layer = keyof typeof labels;
const domains = Object.keys(labels) as Layer[];

function portDomains(port: Port) {
  const layers = new Set<string>();
  for (const i of port.interfaces) {
    if (i.domain === "network" && i.protocol?.startsWith("PoE")) layers.add("power");
    else layers.add(i.domain);
  }
  return layers;
}

export function wireLayers(from: Port, to: Port): Layer[] {
  const a = portDomains(from), b = portDomains(to);
  return domains.filter(domain => a.has(domain) && b.has(domain));
}

export function mountLayers(root: HTMLElement, change: (layer: Layer, visible: boolean) => void) {
  for (const layer of domains) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.layerToggle = layer;
    button.setAttribute("aria-pressed", "true");
    button.textContent = labels[layer];
    button.addEventListener("click", () => {
      const visible = button.getAttribute("aria-pressed") === "false";
      button.setAttribute("aria-pressed", String(visible));
      change(layer, visible);
    });
    root.append(button);
  }
}
