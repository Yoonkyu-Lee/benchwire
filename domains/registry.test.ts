// 등록한 모든 작업 프리셋이 소속 영역의 요청 스키마를 통과하는지 확인한다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { plugins, workloadPresets } from "./registry.ts";

test("등록된 영역에는 스키마를 통과하는 고유한 작업 프리셋이 있다", () => {
  assert.deepEqual([...new Set(workloadPresets.map(preset => preset.domain))], plugins.map(plugin => plugin.id));
  const keys = workloadPresets.map(({ domain, kind }) => JSON.stringify([domain, kind]));
  assert.equal(new Set(keys).size, keys.length);
  for (const preset of workloadPresets) {
    const schema = preset.schema;
    const parsed = schema.safeParse(preset.request);
    assert(parsed.success, `${preset.name} ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`);
    assert(schema instanceof z.ZodType, preset.name);
    assert.doesNotThrow(() => z.toJSONSchema(schema), preset.name);
  }
});
