// 등록한 영역에서 레이어 토글을 만들고 평가 전에는 양쪽 포트의 공통 영역을 그린다.
import { domainNames } from "../domains/registry.ts";
import type { Port } from "./document.ts";

export type Layer = string;

export function wireLayers(from: Port, to: Port): Layer[] {
  const fromDomains = new Set(from.interfaces.map(iface => iface.domain));
  const toDomains = new Set(to.interfaces.map(iface => iface.domain));
  return [...fromDomains.intersection(toDomains)];
}

export function mountLayers(root: HTMLElement, change: (layer: Layer, visible: boolean) => void) {
  for (const [layer, name] of domainNames) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.layerToggle = layer;
    button.setAttribute("aria-pressed", "true");
    button.textContent = name;
    button.addEventListener("click", () => {
      const visible = button.getAttribute("aria-pressed") === "false";
      button.setAttribute("aria-pressed", String(visible));
      change(layer, visible);
    });
    root.append(button);
  }
}
