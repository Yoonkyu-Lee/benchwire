// 공개 규격의 원시 속도·부호 블록·레인 배치로 이론 처리량을 대조한다.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  USB_2_HIGH_SPEED_BULK_LIMIT_MB_PER_SECOND,
  USB_3_2_LINK_MODES,
  USB4_GEN4_LINK_WIDTHS,
  USB4_GEN4_PAM3,
  USB4_NRZ_LINK_MODES,
} from "./constants.ts";

test("USB 2.0 High Speed의 512바이트 벌크 페이로드 상한은 53.248 MB/s다", () => {
  // 출처: USB 2.0 Specification 표 5-10. 125 μs 마이크로프레임당 최대 13개 트랜잭션.
  assert.equal((13 * 512 * 8_000) / 1_000_000, USB_2_HIGH_SPEED_BULK_LIMIT_MB_PER_SECOND);
});

test("USB 3.2의 인코딩 후 이론값은 Gen 1에서 4·8 Gbps, Gen 2에서 약 9.70·19.39 Gbps다", () => {
  // 출처: USB 3.2 Specification Rev 1.1 §4.4.11. Gen 1x1은 500 MB/s, Gen 2x1은 약 1.2 GB/s이고 두 레인은 두 배다.
  for (const [mode, expectedGbps] of [
    ["Gen 1x1", 4],
    ["Gen 1x2", 8],
    ["Gen 2x1", 9.70],
    ["Gen 2x2", 19.39],
  ] as const) {
    const link = USB_3_2_LINK_MODES.find((row) => row.mode === mode);
    assert.ok(link);
    const gbps = link.rawGbpsPerLane * link.lanesPerDirection * link.payloadBits / link.encodedBits;
    assert.equal(Number(gbps.toFixed(2)), expectedGbps, mode);
  }
});

test("USB4 20·40 Gbps의 RS-FEC 미사용 부호 블록 페이로드는 약 19.39·38.79 Gbps다", () => {
  // 출처: USB4 Specification v2.0 (2025-11) §2.2, §4.3.1.2 및 그림 4-22.
  const gen2 = USB4_NRZ_LINK_MODES.find(({ mode }) => mode === "Gen 2x2");
  const gen3 = USB4_NRZ_LINK_MODES.find(({ mode }) => mode === "Gen 3x2");
  assert.ok(gen2 && gen3);

  const gen2Gbps = gen2.rawGbpsPerLane * gen2.lanesPerDirection * gen2.payloadBits / gen2.encodedBits;
  const gen3Gbps = gen3.rawGbpsPerLane * gen3.lanesPerDirection * gen3.payloadBits / gen3.encodedBits;
  assert.equal(Number(gen2Gbps.toFixed(2)), 19.39);
  assert.equal(Number(gen3Gbps.toFixed(2)), 38.79);
});

test("USB4 Gen 4 비대칭 표기는 120/40 Gbps이고 RS-FEC 블록 뒤 이론값은 약 114.94/38.31 Gbps다", () => {
  // 출처: USB-IF USB 80Gbps 발표의 120/40 Gbps, USB4 Specification v2.0 §3.2, §4.3.2.3 및 그림 4-30.
  const { nominalGbpsPerLane, gigaBaudPerLane, bitsPerMapping, tritsPerMapping, fecPayloadSymbols, fecBlockSymbols } = USB4_GEN4_PAM3;
  const symmetric = USB4_GEN4_LINK_WIDTHS.find(({ mode }) => mode === "symmetric");
  const asymmetric = USB4_GEN4_LINK_WIDTHS.find(({ mode }) => mode === "asymmetric");
  assert.ok(symmetric && asymmetric);

  const gbpsPerLane = gigaBaudPerLane * bitsPerMapping / tritsPerMapping * fecPayloadSymbols / fecBlockSymbols;
  assert.equal(nominalGbpsPerLane * symmetric.fastDirectionPairs, 80);
  assert.equal(nominalGbpsPerLane * symmetric.reverseDirectionPairs, 80);
  assert.equal(nominalGbpsPerLane * asymmetric.fastDirectionPairs, 120);
  assert.equal(nominalGbpsPerLane * asymmetric.reverseDirectionPairs, 40);
  assert.equal(Number((gbpsPerLane * symmetric.fastDirectionPairs).toFixed(2)), 76.63);
  assert.equal(Number((gbpsPerLane * asymmetric.fastDirectionPairs).toFixed(2)), 114.94);
  assert.equal(Number((gbpsPerLane * asymmetric.reverseDirectionPairs).toFixed(2)), 38.31);
});
