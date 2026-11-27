// 등록 영역의 수치 격자와 저장 장면, 작업 프리셋을 실제 입력 계약으로 검증한다.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { loadScene } from "../cli/load.ts";
import { domains, plugins, workloadPresets } from "./registry.ts";

test("T10 등록 영역이 수치 입력에 배수 걸음을 두면 그 규격 출처가 있다", () => {
  function check(schema: unknown, field: string, sources: Set<string>) {
    if (typeof schema !== "object" || !schema) return;
    if ("multipleOf" in schema) assert.ok("stepSource" in schema && typeof schema.stepSource === "string" &&
      sources.has(schema.stepSource),field+"의 걸음에 등록된 규격 출처가 필요합니다.");
    for (const [key,child] of Object.entries(schema)) check(child,field+"."+key,sources);
  }
  for (const {plugin,interfaces} of domains) {
    const sources=new Set(plugin.sources.map(s=>s.id));
    const schemas=[plugin.request,plugin.params,plugin.attributes,plugin.observations,...interfaces.map(i=>plugin.paramsFor?.(i.id))];
    for (const schema of schemas) if (schema) {
      assert.ok(schema instanceof z.ZodType,plugin.id);
      check(z.toJSONSchema(schema),plugin.id,sources);
    }
  }
});

test("T10 저장된 영역 장면과 예제를 수치 격자가 적용된 로더로 읽는다",()=>{
  for (const folder of ["data","display","network","power","storage","t2","t4"]) {
    const dir=join("fixtures",folder);
    for (const file of readdirSync(dir).filter(f=>f.endsWith(".json") && !f.includes("@") && f!=="connectors.json"))
      loadScene(join(dir,file),{modelsDir:dir,connectorsFile:join(dir,"connectors.json")},plugins);
  }
  const examples=JSON.parse(readFileSync("fixtures/example/index.json","utf8")).examples as {scene:string;fixture:string}[];
  for (const {scene,fixture} of examples) {
    const dir=join("fixtures",fixture);
    loadScene(join("fixtures/example",scene+".json"),{modelsDir:dir,connectorsFile:"catalog/connectors.json"},plugins);
  }
});

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
