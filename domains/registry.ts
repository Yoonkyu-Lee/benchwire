// 제품의 영역 플러그인과 폼에 쓰는 작업·인터페이스 어휘를 등록한다.
import type { DomainPlugin, InputSchema } from "../engine/contract.ts";
import { data } from "./data/data.ts";
import { dataDomainName, dataInterfaces, dataPresets, dataQuests } from "./data/vocabulary.ts";
import { display } from "./display/display.ts";
import { displayDomainName, displayInterfaces, displayPresets, displayQuests } from "./display/vocabulary.ts";
import { network } from "./network/network.ts";
import { networkDomainName, networkInterfaces, networkPresets, networkQuests } from "./network/vocabulary.ts";
import { power } from "./power/power.ts";
import { powerDomainName, powerInterfaces, powerPresets, powerQuests } from "./power/vocabulary.ts";
import { storageDomain } from "./storage/copy.ts";
import { storageDomainName, storagePresets } from "./storage/vocabulary.ts";

interface Preset {
  kind: string;
  name: string;
  request: Readonly<Record<string, { value: string | number | boolean | null; unit: string }>>;
}
interface InterfaceTerm { id: string; name: string; roles: readonly string[] }
export interface QuestTemplate {
  ownerKind: string; field: string; protocol?: string; title: string; steps: readonly string[]; read: string;
  observation?: { schema: InputSchema; mode?: string; fromLimit?: (limit: number) => number | string | undefined };
}
export interface DomainRegistration {
  plugin: DomainPlugin; name: string; presets: readonly Preset[]; interfaces: readonly InterfaceTerm[]; quests?: readonly QuestTemplate[];
}

export const domains: readonly DomainRegistration[] = [
  { plugin: data, name: dataDomainName, presets: dataPresets, interfaces: dataInterfaces, quests: dataQuests },
  { plugin: display, name: displayDomainName, presets: displayPresets, interfaces: displayInterfaces, quests: displayQuests },
  { plugin: network, name: networkDomainName, presets: networkPresets, interfaces: networkInterfaces, quests: networkQuests },
  { plugin: power, name: powerDomainName, presets: powerPresets, interfaces: powerInterfaces, quests: powerQuests },
  { plugin: storageDomain, name: storageDomainName, presets: storagePresets, interfaces: [] },
];

export const plugins = domains.map(({ plugin }) => plugin);
export const domainNames: ReadonlyMap<string, string> = new Map(domains.map(({ plugin, name }) => [plugin.id, name]));
export function workPresets(registrations: readonly DomainRegistration[]) {
  return registrations.flatMap(({ plugin, presets }) =>
    presets.map(preset => ({ ...preset, domain: plugin.id, schema: plugin.request })));
}
export const workloadPresets = workPresets(domains);

export function workloadKindName(domain: string, kind: string) {
  return workloadPresets.find(preset => preset.domain === domain && preset.kind === kind)?.name
    ?? [domainNames.get(domain) ?? domain, kind].filter(Boolean).join(" ");
}
