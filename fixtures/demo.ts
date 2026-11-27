// 합성 시험 영역을 명시적으로 추가해 CLI의 평가·비교 데모를 실행한다.
import { compareCommand } from "../cli/compare.ts";
import { evaluateCommand } from "../cli/evaluate.ts";
import { plugins } from "../domains/registry.ts";
import { trialDomain } from "./trial.ts";

const [command,...args] = process.argv.slice(2);
if (command === "evaluate" || command === "compare") {
  const trial = trialDomain();
  const run = command === "evaluate" ? evaluateCommand : compareCommand;
  run(args,[...plugins,trial]);
  if (!process.exitCode) console.log("시험 전용 영역 " + trial.id);
} else {
  console.error("사용법 · node fixtures/demo.ts <evaluate|compare> <장면과 옵션>");
  process.exitCode = 1;
}
