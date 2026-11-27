// 태그 없는 이더넷 프레임의 페이로드 효율을 공개 회선 수치와 대조한다.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ETHERNET_UNTAGGED_FRAME } from "./constants.ts";

test("MTU 1500의 회선 점유량은 1538바이트 시간이고 MAC 페이로드 효율은 약 97.53%다", () => {
  // 출처: RFC 6349의 1538 바이트 전송 비용과 1 Gbps에서 초당 최대 81,274 프레임.
  const { mtuBytes, macHeaderBytes, fcsBytes, preambleBytes, sfdBytes, interFrameGapByteTimes } = ETHERNET_UNTAGGED_FRAME;
  const wireByteTimes = mtuBytes + macHeaderBytes + fcsBytes + preambleBytes + sfdBytes + interFrameGapByteTimes;
  assert.equal(wireByteTimes, 1_538);
  assert.equal(Number((100 * mtuBytes / wireByteTimes).toFixed(2)), 97.53);
  assert.equal(Math.floor(1_000_000_000 / (8 * wireByteTimes)), 81_274);
});
