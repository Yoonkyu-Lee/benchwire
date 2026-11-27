// 입력에서 먼저 쓰는 전력과 독립 공급을 증명하는 모델 간선을 엔진의 공급 경로 탐색에 넘긴다.
import { effectiveClaim, readClaim, type FeedLoad, type Scene } from "../../engine/contract.ts";
import { PD, POWER, POWER_UNIT } from "./input.ts";
import { PD_FIXED } from "./sources.ts";

export function standingLoads(scene: Scene): FeedLoad[] {
  const loads: FeedLoad[] = [], sources: FeedLoad["feed"]["sources"][number][] = [];
  const inputs=new Set<number>(), outputs=new Set<number>();
  for (const [row,iface] of scene.interfaces.entries()) {
    if (iface.domain!==POWER || iface.protocol!==PD) continue;
    const item=scene.ports[iface.port]!.item;
    if (iface.role==="source") outputs.add(item);
    if (iface.role!=="sink") continue;
    inputs.add(item);
    const reserve=effectiveClaim(scene,"interface",row,POWER,"reserveW");
    if (reserve===undefined || !scene.connections.some(c=>c.from===iface.port || c.to===iface.port)) continue;
    const amount=readClaim(scene,reserve).value as number|null;
    loads.push({item,id:"reserveW:"+scene.ports[iface.port]!.id,unit:POWER_UNIT,amount,
      feed:{inputPort:iface.port,mode:PD,sources},inputs:[reserve,iface.evidence],specs:[PD_FIXED],
      rule:amount===null ? "패스스루 자체 소비 미확인" : `패스스루 자체 소비 ${amount} W 우선 사용`});
  }
  if (!loads.length) return loads;
  for (const item of outputs) {
    const ports=scene.interfaces.flatMap((i,row)=>i.domain===POWER && i.protocol===PD && i.role==="source" && scene.ports[i.port]!.item===item ? [{...i,row}] : []);
    const declarations=ports.flatMap(p=>{
      const row=effectiveClaim(scene,"interface",p.row,POWER,"sourceNode");
      return row===undefined ? [] : [{row,port:p}];
    });
    if (declarations.length) {
      for (const {row,port} of declarations) {
        const value=readClaim(scene,row).value;
        scene.nodes.forEach((n,node)=>{
          if (n.item===item && (value===null || n.id===value)) sources.push({node,possible:value===null,
            inputs:[row,port.evidence],specs:[],rule:"모델의 독립 전력 공급 노드"});
        });
      }
      continue;
    }
    if (inputs.has(item)) continue;
    const edges=scene.edges.filter(e=>e.item===item);
    // 송전 전용 실물의 내부 배선 시작점에서 실제 출력과 전력 예산 간선을 함께 거친다.
    for (const [node,n] of scene.nodes.entries()) {
      if (n.item!==item || edges.some(e=>e.to===node)) continue;
      const outgoing=scene.edges.flatMap((e,i)=>e.from===node ? [i] : []);
      const uses=scene.resourceUses.filter(u=>outgoing.includes(u.edge) && scene.resources[u.resource]!.unit===POWER_UNIT);
      const proof=ports.map(p=>p.evidence);
      if (outgoing.length) proof.push(...outgoing.map(i=>scene.edges[i]!.evidence),...uses.map(u=>u.evidence));
      else if (!ports.some(p=>{const a=effectiveClaim(scene,"port",p.port,"","attachment")!;
        if (readClaim(scene,a).attachmentNode!==node) return false;
        proof.push(a); return true;
      })) continue;
      sources.push({node,inputs:proof,specs:[],rule:"독립 송전 장치의 공급 시작점"});
    }
  }
  return loads;
}
