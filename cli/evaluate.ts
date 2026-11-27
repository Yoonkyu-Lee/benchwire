// 장면 파일과 영역 목록을 열어 판정 결과를 터미널에 출력한다.
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { evaluate } from "../engine/evaluate.ts";
import { display } from "../domains/display/display.ts";
import { network } from "../domains/network/network.ts";
import { power } from "../domains/power/power.ts";
import { storageDomain } from "../domains/storage/copy.ts";
import { trialDomain } from "../fixtures/trial.ts";
import { loadScene } from "./load.ts";
import { printResults } from "./print.ts";

function main() {
  const trial = trialDomain();
  const plugins = [display, network, power, storageDomain, trial];
  let scene;
  try {
    const { positionals, values } = parseArgs({
      allowPositionals: true,
      options: { models: { type: "string" }, connectors: { type: "string" } },
    });
    const [file, extra] = positionals;
    if (!file || extra !== undefined) throw new Error("사용법 · node cli/evaluate.ts <장면 파일> [--models <폴더>] [--connectors <파일>]");
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
}

main();
