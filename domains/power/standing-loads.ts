// 상시 입력과 송전 포트의 독립 전원 주장을 엔진의 공급 경로 탐색에 넘긴다.
import { effectiveClaim, readClaim, type FeedLoad, type Scene } from "../../engine/contract.ts";
import { PD, POWER, POWER_UNIT } from "./input.ts";
import { PD_FIXED } from "./sources.ts";

export function sourceNodes(scene: Pick<Scene,"interfaces" | "ports" | "nodes">, iface: number) {
  const item=scene.ports[scene.interfaces[iface]!.port]!.item;
  return scene.nodes.flatMap((n,row)=>n.item===item ? [row] : []);
}

export function standingLoads(scene: Scene): FeedLoad[] {
  const loads: FeedLoad[] = [], sources: FeedLoad["feed"]["sources"][number][] = [];
  const connected=new Set(scene.connections.flatMap(c=>[c.from,c.to]));
  for (const [row,iface] of scene.interfaces.entries()) {
    if (iface.domain!==POWER || iface.protocol!==PD) continue;
    const item=scene.ports[iface.port]!.item;
    if (iface.role!=="sink") continue;
    const reserve=effectiveClaim(scene,"interface",row,POWER,"reserveW");
    if (reserve===undefined || !connected.has(iface.port)) continue;
    const amount=readClaim(scene,reserve).value as number|null;
    loads.push({item,id:"reserveW:"+scene.ports[iface.port]!.id,unit:POWER_UNIT,amount,
      feed:{inputPort:iface.port,mode:PD,sources},inputs:[reserve,iface.evidence],specs:[PD_FIXED],
      rule:amount===null ? "패스스루 자체 소비 미확인" : `패스스루 자체 소비 ${amount} W 우선 사용`});
  }
  if (!loads.length) return loads;
  for (const [row,iface] of scene.interfaces.entries()) {
    if (iface.domain!==POWER || iface.protocol!==PD || iface.role!=="source" || !connected.has(iface.port)) continue;
    const claim=effectiveClaim(scene,"interface",row,POWER,"sourceNode");
    const value=claim===undefined ? null : readClaim(scene,claim).value;
    if (value==="") continue;
    const nodes=sourceNodes(scene,row);
    const known=nodes.find(node=>scene.nodes[node]!.id===value);
    for (const node of known===undefined ? nodes : [known]) sources.push({
      node,outputPort:iface.port,possible:known===undefined,inputs:claim===undefined ? [iface.evidence] : [claim,iface.evidence],
      specs:[],rule:"송전 포트의 독립 전원 노드"
    });
  }
  return loads;
}
