// 제품에서 함께 사용하는 영역 플러그인과 작업 프리셋을 등록한다.
import type { DomainPlugin } from "../engine/contract.ts";
import { data } from "./data/data.ts";
import { dataDomainName, dataPresets } from "./data/presets.ts";
import { display } from "./display/display.ts";
import { displayDomainName, displayPresets } from "./display/presets.ts";
import { network } from "./network/network.ts";
import { networkDomainName, networkPresets } from "./network/presets.ts";
import { power } from "./power/power.ts";
import { powerDomainName, powerPresets } from "./power/presets.ts";
import { storageDomain } from "./storage/copy.ts";
import { storageDomainName, storagePresets } from "./storage/presets.ts";

interface Preset {
  kind: string;
  name: string;
  request: Readonly<Record<string, { value: string | number | boolean | null; unit: string }>>;
  labels: Readonly<Record<string, string>>;
}

const domains: readonly { plugin: DomainPlugin; name: string; presets: readonly Preset[] }[] = [
  { plugin: data, name: dataDomainName, presets: dataPresets },
  { plugin: display, name: displayDomainName, presets: displayPresets },
  { plugin: network, name: networkDomainName, presets: networkPresets },
  { plugin: power, name: powerDomainName, presets: powerPresets },
  { plugin: storageDomain, name: storageDomainName, presets: storagePresets },
];

export const plugins = domains.map(({ plugin }) => plugin);
export const domainNames: ReadonlyMap<string, string> = new Map(domains.map(({ plugin, name }) => [plugin.id, name]));
export const workloadPresets = domains.flatMap(({ plugin, presets }) =>
  presets.map(preset => ({ ...preset, domain: plugin.id, schema: plugin.request })));

export function workloadKindName(domain: string, kind: string) {
  return workloadPresets.find(preset => preset.domain === domain && preset.kind === kind)?.name
    ?? [domainNames.get(domain) ?? domain, kind].filter(Boolean).join(" ");
}
