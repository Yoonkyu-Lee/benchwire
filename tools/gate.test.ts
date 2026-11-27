// 게이트가 저장소 약속을 지키는지 확인한다. 시험 이름이 곧 지키는 약속이다.

import assert from "node:assert/strict";
import { test } from "node:test";
import { checkDependencies, checkDeviceNames, checkExcuses, checkHeader, checkImports, checkName, checkSecrets } from "./gate.ts";
import type { Finding } from "./gate.ts";

const fails = (xs: Finding[]): number => xs.filter((x) => x.level === "FAIL").length;

test("소스 파일은 역할을 적은 주석 한 줄로 시작한다", () => {
  assert.equal(fails(checkHeader("engine/run.ts", "// 판정 파이프라인\nexport {};\n")), 0);
  assert.equal(fails(checkHeader("engine/run.ts", "export {};\n")), 1);
  assert.equal(fails(checkHeader("collector/collect.ps1", "# 장치 나무를 읽는다\n")), 0);
});

test("개념이 아닌 모음 이름을 막는다", () => {
  assert.equal(fails(checkName("engine/utils.ts")), 1);
  assert.equal(fails(checkName("domains/shared/units.ts")), 1);
  assert.equal(fails(checkName("engine/allocate.test.ts")), 0);
});

test("엔진은 엔진 안의 파일만 가져온다: 플러그인 · 화면 · node: 모듈 · 패키지 금지 (시험 파일은 예외)", () => {
  assert.equal(fails(checkImports("engine/run.ts", 'import { display } from "../domains/display/rules.ts";')), 1);
  assert.equal(fails(checkImports("engine/run.ts", 'import { readFileSync } from "node:fs";')), 1);
  assert.equal(fails(checkImports("engine/run.ts", 'import { z } from "zod";')), 1);
  assert.equal(fails(checkImports("engine/run.ts", 'import type { Scene } from "./scene.ts";')), 0);
  assert.equal(fails(checkImports("engine/run.test.ts", 'import { test } from "node:test";')), 0);
});

test("영역 플러그인은 엔진 계약(engine/contract.ts)과 자기 폴더만 가져온다", () => {
  const ok = 'import type { Plugin } from "../../engine/contract.ts";\nimport { LIMITS } from "./constants.ts";\nimport { z } from "zod";';
  assert.equal(fails(checkImports("domains/power/rules.ts", ok)), 0);
  assert.equal(fails(checkImports("domains/power/rules.ts", 'import { allocate } from "../../engine/allocate.ts";')), 1);
  assert.equal(fails(checkImports("domains/power/rules.ts", 'import { usb } from "../data/rules.ts";')), 1);
});

test("카탈로그의 기기 이름이 엔진 · 플러그인 코드에 나오면 막는다", () => {
  const names = ["Contoso Dock 9"];
  assert.equal(fails(checkDeviceNames("domains/data/rules.ts", 'if (model === "contoso dock 9") {}', names)), 1);
  assert.equal(fails(checkDeviceNames("fixtures/t4.ts", 'const dock = "Contoso Dock 9";', names)), 0);
});

test("의존성은 README 의존성 표에 까닭과 함께 있다", () => {
  const pkg = { devDependencies: { typescript: "7.0.2" } };
  assert.equal(fails(checkDependencies(pkg, "| `typescript` (dev) | 형 검사 |")), 0);
  assert.equal(fails(checkDependencies(pkg, "의존성 표 없음")), 1);
});

test("API 키 모양의 문자열과 .env 파일을 막는다", () => {
  assert.equal(fails(checkSecrets("server/llm.ts", `const key = "${"sk-" + "ant-" + "a".repeat(24)}";`)), 1);
  assert.equal(fails(checkSecrets(".env", "ANTHROPIC_API_KEY=x")), 1);
  assert.equal(fails(checkSecrets(".env.example", "ANTHROPIC_API_KEY=")), 0);
});

test("땜질을 변명하는 주석은 경고한다", () => {
  assert.equal(checkExcuses("engine/run.ts", ["retry();", "// 일단 재시도"].join(" ")).length, 1);
  assert.equal(checkExcuses("engine/run.ts", 'const url = "https://example.com"; // 출처: 규격 5.2절').length, 0);
});
