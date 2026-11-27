// CLI 명령들이 함께 여는 영역 플러그인 목록. 엔진에는 전역 등록부가 없어(SPEC 5.2) 호출자가 여기서 정한다.
import { data } from "../domains/data/data.ts";
import { display } from "../domains/display/display.ts";
import { network } from "../domains/network/network.ts";
import { power } from "../domains/power/power.ts";
import { storageDomain } from "../domains/storage/copy.ts";
import { trialDomain } from "../fixtures/trial.ts";

// 시험 전용 영역은 데모 장면을 열 수 있게 함께 넣고, 출력에서 시험 전용임을 밝힌다.
export const trial = trialDomain();
export const plugins = [data, display, network, power, storageDomain, trial];
