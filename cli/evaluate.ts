// 장면 파일과 영역 목록을 열어 판정 결과를 터미널에 출력한다.
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { evaluate, evaluateVariants } from "../engine/evaluate.ts";
import { plugins, trial } from "./domains.ts";
import { loadScene } from "./load.ts";
import { printResults, printVariant } from "./print.ts";

function main() {
  let scene;
  let showVariants: boolean | undefined;
  try {
    const { positionals, values } = parseArgs({
      allowPositionals: true,
      options: { models: { type: "string" }, connectors: { type: "string" }, variants: { type: "boolean" } },
    });
    const [file, extra] = positionals;
    if (!file || extra !== undefined) throw new Error("사용법 · node cli/evaluate.ts <장면 파일> [--models <폴더>] [--connectors <파일>] [--variants]");
    showVariants = values.variants;
    const sceneDir = dirname(file);
    scene = loadScene(file, {
      modelsDir: values.models ?? sceneDir,
      connectorsFile: values.connectors ?? join(sceneDir, "connectors.json"),
    }, plugins);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    console.error(`오류 · ${error.message.replace(/[\p{Cc}\u2028\u2029]+/gu, " ")}`);
    process.exitCode = 1;
    return;
  }
  const result = evaluate(scene, plugins);
  if (result.outcomes.some(o => o.domain === trial.id)) console.log(`시험 전용 영역 ${trial.id}`);
  console.log(printResults(scene, result));
  if (showVariants) {
    let order = 0;
    scene.scenarios.forEach((_, scenario) => {
      for (const { result: variant } of evaluateVariants(scene, plugins, scenario).slice(1))
        console.log("\n" + printVariant(scene, result, variant, scenario, ++order));
    });
  }
}

main();
