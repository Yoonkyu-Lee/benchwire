// USB PD 고정 PDO와 USB-C 전류가 만드는 전력 한도를 공개 수치와 대조한다.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  USB_C_CABLE_CURRENT_RATINGS_A,
  USB_C_CURRENT_NOMINAL_VOLTAGE_V,
  USB_C_DEFAULT_CURRENT_LIMITS,
  USB_C_EXPLICIT_RP_CURRENT_LEVELS_MA,
  USB_PD_FIXED_SOURCE_LIMITS,
  USB_PD_POWER_LIMITS_W,
} from "./constants.ts";

test("SPR 20 V는 케이블 3 A에서 60 W, 5 A에서 100 W이고 EPR 48 V·5 A는 240 W다", () => {
  // 출처: USB Power Delivery r3.2 v1.2 §3.2.2·§3.2.5.3 및 표 3.1·3.5.
  const spr = USB_PD_FIXED_SOURCE_LIMITS.find(({ voltageV }) => voltageV === 20);
  const epr = USB_PD_FIXED_SOURCE_LIMITS.find(({ voltageV }) => voltageV === 48);
  assert.ok(spr && epr);

  const [threeAmp, fiveAmp] = USB_C_CABLE_CURRENT_RATINGS_A;
  assert.equal(spr.voltageV * threeAmp, 60);
  assert.equal(spr.voltageV * Math.min(spr.maxCurrentA, fiveAmp), 100);
  assert.equal(epr.voltageV * Math.min(epr.maxCurrentA, fiveAmp), 240);
  assert.equal(USB_PD_POWER_LIMITS_W.SPR, 100);
  assert.equal(USB_PD_POWER_LIMITS_W.EPR, 240);
});

test("USB-C 5 V에서 기본 버스 전류와 명시적 Rp 전류가 만드는 전력은 표 4-20과 맞는다", () => {
  // 출처: USB Type-C Cable and Connector Specification Release 2.5 표 4-20.
  for (const [bus, expectedW] of [
    ["USB 2.0", 2.5],
    ["USB 3.2 x1", 4.5],
    ["USB 3.2 x2", 7.5],
  ] as const) {
    const row = USB_C_DEFAULT_CURRENT_LIMITS.find((entry) => entry.bus === bus);
    assert.ok(row);
    assert.equal(USB_C_CURRENT_NOMINAL_VOLTAGE_V * row.maxCurrentMa / 1_000, expectedW, bus);
  }

  const powerLevelsW = USB_C_EXPLICIT_RP_CURRENT_LEVELS_MA.map(
    (currentMa) => USB_C_CURRENT_NOMINAL_VOLTAGE_V * currentMa / 1_000,
  );
  assert.deepEqual(powerLevelsW.toSorted((a, b) => a - b), [7.5, 15]);
});
