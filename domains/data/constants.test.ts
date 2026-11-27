// USB 2.0 벌크 상한과 USB4 대칭 링크의 부호화 상한을 규격의 계산값과 대조한다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { USB_2_HIGH_SPEED_BULK_LIMIT_MB_PER_SECOND, USB4_LINK_MODES } from "./constants.ts";

test("USB 2.0 High Speed의 512바이트 벌크 페이로드 상한은 53.248 MB/s다", () => {
  // 출처: USB 2.0 Specification 표 5-10. 125 μs 마이크로프레임당 최대 13개 트랜잭션.
  assert.equal((13 * 512 * 8_000) / 1_000_000, USB_2_HIGH_SPEED_BULK_LIMIT_MB_PER_SECOND);
});

test("USB4 20·40·80 Gbps 대칭 링크의 부호 블록 페이로드 한도는 약 19.39·38.79·76.63 Gbps다", () => {
  assert.deepEqual(USB4_LINK_MODES.map(mode => Number(mode.payloadGbps.toFixed(2))), [19.39, 38.79, 76.63]);
});
