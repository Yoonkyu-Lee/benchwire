// 제품에서 함께 사용하는 영역 플러그인을 등록한다.
import { data } from "./data/data.ts";
import { display } from "./display/display.ts";
import { network } from "./network/network.ts";
import { power } from "./power/power.ts";
import { storageDomain } from "./storage/copy.ts";

export const plugins = [data, display, network, power, storageDomain];
