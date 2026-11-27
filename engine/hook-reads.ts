// 훅이 읽은 미확인 주장은 모두 목표의 세계 변수다. 엔진이 배분에만 쓴 자원 용량만 구간으로 남긴다.
import { readClaim, type Scene } from "./scene.ts";
import type { Results } from "./results.ts";

export type Hook = "negotiate" | "pools" | "laneProfiles" | "match" | "demand" | "consume" | "assess" | "policy" | "standingLoads";
// row는 협상·풀에 방향별 링크 자원, 레인에 연결, 수요·일치·판정에 작업, 소비에 경로, 정책에 자원을 가리킨다.
export interface HookRead { hook: Hook; row: number; claims: number[] }

export function callHook<T>(scene: Scene, result: Results, hook: Hook, row: number, run: (view:Scene)=>T) {
  if (!result.readClaims && hook!=="policy") return {value:run(scene),claims:[]};
  const claimReads=new Set<number>();
  const value=run({...scene,claimReads});
  const claims=[...claimReads];
  if (result.readClaims) {
    const view={...scene,claimUses:result.readClaims};
    const pending=claims.filter(id=>readClaim(view,id).value===null);
    if (pending.length) (result.hookReads ??= []).push({hook,row,claims:pending});
  }
  return {value,claims};
}
