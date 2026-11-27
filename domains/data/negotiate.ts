// 양 끝의 USB 모드와 중간 부품의 등급을 맞추고 벌크 서비스와 공용 예산을 낸다.
// USB4의 방향별 터널 예산은 대칭 모드의 확인된 가용량을 쓰며, 미확인 값의 상한은 부호 블록으로 제한한다.
import { effectiveClaim, type Claim, type Link, type Option, type Pool } from "../../engine/contract.ts";
import {
  GIGABITS_PER_MEGABYTE, USB_2_HIGH_SPEED_BULK_LIMIT_MB_PER_SECOND, USB_2_HIGH_SPEED_MODE,
  USB_2_HIGH_SPEED_SIGNAL_GBPS, USB_3_2_PROTOCOL_ESTIMATES, USB4_LINK_MODES,
} from "./constants.ts";
import { BULK, DATA, MB_PER_SECOND, parseModes, PCIE_TUNNEL, USB, USB4 } from "./input.ts";
import { CABLE_DATA, USB2_BULK, USB3_ESTIMATE, USB4_LINK, USB4_TUNNELS } from "./sources.ts";

const USB2_POOL = "usb2-bulk";
const TUNNEL_POOL = "usb4-tunnel";

const highSpeed = { mode: USB_2_HIGH_SPEED_MODE, rawGbps: USB_2_HIGH_SPEED_SIGNAL_GBPS,
  approxBestCaseMBPerSecond: USB_2_HIGH_SPEED_BULK_LIMIT_MB_PER_SECOND };
const usbModes = [highSpeed, ...USB_3_2_PROTOCOL_ESTIMATES];

function modeRange<T extends { mode: string; rawGbps: number }>(rows: readonly T[],
  endModes: (string[] | null)[], ratings: (number | null)[]) {
  const cap = Math.min(Infinity, ...ratings.map(rating => rating ?? Infinity));
  const possible = rows.findLast(row => row.rawGbps <= cap && endModes.every(modes => modes === null || modes.includes(row.mode)));
  const confirmed = rows.findLast(row => row.rawGbps <= cap && !ratings.includes(null) &&
    endModes.every(modes => modes?.includes(row.mode)));
  return { confirmed, possible };
}

export function usbServices({ scene, connection, ports }: Link): { options: Option[]; pools: Pool[] } {
  const inputs = new Set([scene.connections[connection]!.evidence]);
  function read(kind: Claim["ownerKind"], owner: number, field: string) {
    const row = effectiveClaim(scene, kind, owner, DATA, field);
    if (row === undefined) return null;
    inputs.add(row);
    return scene.claims[row]!.value;
  }
  function endRows(protocol: string) {
    return [ports[0], ports.at(-1)].map(port => {
      const row = scene.interfaces.findIndex(i => i.port === port && i.domain === DATA && i.protocol === protocol && i.role === "bidirectional");
      if (row >= 0) inputs.add(scene.interfaces[row]!.evidence);
      return row;
    });
  }
  function modes(rows: number[], field: string) {
    return rows.map(row => {
      if (row < 0) return [];
      const value = read("interface", row, field);
      return typeof value === "string" ? parseModes(value) : null;
    });
  }

  const nativeModes = modes(endRows(USB), "modes");
  const fabricEnds = endRows(USB4);
  const fabricModes = modes(fabricEnds, "modes");
  const parts = scene.parts.filter(part => part.connection === connection);
  const cableRates = parts.map(part => read("item", part.item, "cableDataGbps") as number | null);
  const fabricRates = parts.flatMap((part, i) => {
    const rating = cableRates[i]!;
    if (rating === USB_2_HIGH_SPEED_SIGNAL_GBPS) return [0];
    const allowed = read("item", part.item, "cableUsb4");
    return allowed === false ? [0] : allowed === true ? [rating] : [rating, null];
  });
  const fabric = modeRange(USB4_LINK_MODES, fabricModes, fabricRates);
  const caps = fabric.possible ? fabricEnds.map(row => read("interface", row, "tunnelGbps") as number | null) : [];
  const tunnelHigh = Math.min(fabric.possible?.payloadGbps ?? 0, ...caps.map(cap => cap ?? Infinity));
  const known = tunnelHigh === 0 || fabric.possible === fabric.confirmed && !caps.includes(null);
  const specs = [USB4_LINK, USB4_TUNNELS, CABLE_DATA];
  const pools: Pool[] = [{ id: TUNNEL_POOL, scope: "direction", unit: "Gbps", limit: known ? tunnelHigh : null,
    ...(known ? {} : { bounds: { low: 0, high: tunnelHigh } }), inputs: [...inputs], specs,
    rule: fabric.possible ? `USB4 ${fabric.possible.mode} 방향별 공용 터널 예산 ${known ? tunnelHigh : "0–" + tunnelHigh} Gbps`
      : "양 끝과 중간 부품에서 함께 쓸 USB4 모드가 없어 방향별 공용 터널 예산은 0 Gbps" }];
  const options: Option[] = [];
  let tunneledBulk: Option | undefined;

  if (fabric.possible) {
    const usb3 = modeRange(USB_3_2_PROTOCOL_ESTIMATES, modes(fabricEnds, "usb3Modes"), []);
    const pcie = fabricEnds.map(row => read("interface", row, "pcie"));
    const poolRef = { domain: DATA, id: TUNNEL_POOL, perUnit: GIGABITS_PER_MEGABYTE };
    if (!pcie.includes(false)) {
      const limit = fabric.possible.payloadGbps / GIGABITS_PER_MEGABYTE;
      const confirmed = !!fabric.confirmed && pcie.every(x => x === true);
      options.push({ mode: PCIE_TUNNEL, unit: MB_PER_SECOND, verdict: confirmed ? "ok" : "unknown", condition: "",
        limit: confirmed ? limit : null, ...(confirmed ? {} : { bounds: { low: 0, high: limit } }),
        rule: "USB4의 PCIe 터널이 방향별 공용 예산을 사용", inputs: [...inputs], specs, pool: poolRef });
    }
    if (usb3.possible) tunneledBulk = {
      ...bulkOption(usb3.possible, fabric.confirmed ? usb3.confirmed : undefined, [...inputs], [...specs, USB3_ESTIMATE], "USB4 USB3 터널 "),
      pool: poolRef,
    };
  }

  // USB4가 성립하면 USB 2.0만 전용 배선으로 동시에 지나갈 수 있다.
  const native = modeRange(fabric.confirmed ? [highSpeed] : usbModes, nativeModes, cableRates);
  const facts = [...inputs];
  const usb2 = native.possible === highSpeed;
  if (native.possible && (tunneledBulk?.verdict === "unknown" || !usb2 && fabric.possible && !fabric.confirmed)) {
    // 링크의 설정을 확정할 수 없어 공용 예산이 다른 대안들을 한 범위로 보존한다.
    const tunnelBound = tunnelHigh / GIGABITS_PER_MEGABYTE;
    const tunnel = Math.min(tunnelBound, tunneledBulk?.bounds?.high ?? tunneledBulk?.limit ?? 0);
    const high = Math.max(native.possible.approxBestCaseMBPerSecond, tunnel);
    options.push({ mode: BULK, unit: MB_PER_SECOND, verdict: "unknown", condition: "", limit: null,
      bounds: { low: 0, high }, inputs: facts,
      specs: [USB4_LINK, USB4_TUNNELS, CABLE_DATA, USB3_ESTIMATE, ...(usb2 ? [USB2_BULK] : [])],
      rule: `USB4 또는 일반 USB 연결에서 가능한 벌크 처리량 0–${high} MB/s` });
  } else if (tunneledBulk) {
    options.push(tunneledBulk);
  } else if (native.possible) {
    const alt = !fabric.possible && !usb2 ? altModePins(scene, ports) : null;
    if (alt) {
      const usb2Fallback = modeRange([highSpeed], nativeModes, cableRates);
      if (usb2Fallback.possible) addNative(usb2Fallback.possible, usb2Fallback.confirmed);
      addNative(native.possible, native.confirmed, "usb-only");

      if (alt.twoLane) {
        // 핀 D가 USB에 남기는 송·수신 쌍으로는 USB 3.x 한 레인만 쓸 수 있다.
        const oneLane = USB_3_2_PROTOCOL_ESTIMATES.filter(row => row.mode.endsWith("x1"));
        const usb3 = modeRange(oneLane, nativeModes, cableRates);
        if (usb3.possible) addNative(usb3.possible, usb3.confirmed, "dp-2lane", alt.twoLane);
      }
    } else {
      addNative(native.possible, native.confirmed);
    }
  } else if (!options.length) {
    options.push({ mode: BULK, unit: MB_PER_SECOND, verdict: "impossible", condition: "", limit: null,
      rule: "양 끝과 중간 부품에서 함께 쓸 USB 모드 없음", inputs: facts, specs: [USB2_BULK, USB3_ESTIMATE, CABLE_DATA] });
  }
  return { options, pools };

  function addNative(possible: typeof usbModes[number], confirmed: typeof usbModes[number] | undefined, profile?: string, pins: number[] = []) {
    const usb2 = possible === highSpeed;
    const specs = usb2 ? [USB2_BULK, CABLE_DATA] : [USB3_ESTIMATE, CABLE_DATA];
    if (confirmed === highSpeed && !usb2) specs.push(USB2_BULK);
    const option = bulkOption(possible, confirmed, [...facts, ...pins], specs, usb2 ? "USB 2.0 " : "USB 3.2 ");
    if (profile) option.profile = profile;
    if (usb2) {
      option.pool = { domain: DATA, id: USB2_POOL, perUnit: 1 };
      pools.push({ id: USB2_POOL, scope: "connection", unit: MB_PER_SECOND, limit: option.limit,
        ...(option.bounds ? { bounds: option.bounds } : {}), inputs: facts, specs,
        rule: "USB 2.0 High Speed의 양방향 공용 벌크 시간 예산" });
    }
    options.push(option);
  }
}

// 연결 설정은 양방향을 공유한다. 네이티브 USB 3.x가 경쟁하는 Alt Mode 경로만 확인한다.
function altModePins(scene: Link["scene"], ports: number[]) {
  function interfaces(port: number | undefined) {
    return scene.interfaces.flatMap((i, row) => i.port === port && i.domain === "display" && i.protocol === "DP Alt Mode"
      ? [{ row, role: i.role }] : []);
  }
  if (!ports.slice(1, -1).every(port => interfaces(port).some(i => i.role === "bidirectional"))) return null;
  const ends = interfaces(ports.at(-1));
  const supports = (role: string, wanted: string) => role === wanted || role === "bidirectional";
  const pairs = interfaces(ports[0]).flatMap(a => ends.flatMap(b => supports(a.role, "source") && supports(b.role, "sink") ||
    supports(a.role, "sink") && supports(b.role, "source") ? [[a.row, b.row]] : []));
  function claims(profile: string, allowed: readonly string[]) {
    const matches = pairs.map(pair => pair.map(row => effectiveClaim(scene, "interface", row, "display", "pin", profile)))
      .filter(rows => {
        const [a, b] = rows.map(row => row === undefined ? null : scene.claims[row]!.value as string | null);
        const pin = a ?? b;
        return pin == null || allowed.includes(pin) && (a === null || b === null || a === b);
      });
    return matches.find(rows => rows.every(row => row !== undefined && scene.claims[row]!.value !== null)) ?? matches[0];
  }

  const d = claims("dp-2lane", ["D"]);
  if (!d && !claims("dp-4lane", ["C", "E"])) return null;
  // 한쪽 핀만 알 때 USB 3.x를 추가로 보장할 수 없다.
  const confirmed = d?.filter(row => row !== undefined);
  const twoLane = confirmed?.length === 2 && confirmed.every(row => scene.claims[row]!.value === "D") ? confirmed : null;
  return { twoLane };
}

function bulkOption(possible: typeof usbModes[number], confirmed: typeof usbModes[number] | undefined,
  inputs: number[], specs: string[], prefix: string): Option {
  const high = possible.approxBestCaseMBPerSecond;
  const low = confirmed?.approxBestCaseMBPerSecond ?? 0;
  const known = low === high;
  const label = known ? possible.mode : `최대 ${possible.mode}`;
  const estimate = possible === highSpeed ? "규격 벌크 페이로드 상한" : "규격의 최적 조건 처리량 추정 상한";
  return { mode: BULK, unit: MB_PER_SECOND, verdict: known ? "ok" : "unknown", condition: "",
    limit: known ? high : null, ...(known ? {} : { bounds: { low, high } }), inputs, specs,
    rule: `${prefix}${label} · ${estimate}(official) ${known ? high : low + "–" + high} MB/s` };
}
