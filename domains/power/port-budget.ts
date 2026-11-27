// 물리적으로 접속한 출력 포트의 조합을 읽어 한 링크가 공유할 포트 전력 한도를 구한다.
import { hasClaimPrefix, readClaim, effectiveClaim, type Scene } from "../../engine/contract.ts";
import { PD, POWER } from "./input.ts";

function outletPorts(scene:Pick<Scene,"interfaces" | "ports">,item:number) {
  return new Set(scene.interfaces.filter(i => i.domain === POWER && i.protocol === PD && i.role === "source" &&
    scene.ports[i.port]!.item === item).map(i => i.port));
}

export function portBudgetError(scene:Pick<Scene,"interfaces" | "ports">,item:number,field:string) {
  const [,combination,output]=field.split(":");
  const ports=combination!.split("+");
  const outlets=new Set([...outletPorts(scene,item)].map(row=>encodeURIComponent(scene.ports[row]!.id)));
  const missing=ports.find(id=>!outlets.has(id));
  if (missing!==undefined || !outlets.has(output!)) return "이 모델에 없는 출력 포트: "+(missing??output);
  if (!ports.includes(output!)) return "접속 조합에 없는 출력 포트: "+output;
  return undefined;
}

export function portBudget(scene: Scene, sourcePort: number) {
  const { item, id } = scene.ports[sourcePort]!;
  if (!hasClaimPrefix(scene,"item",item,POWER,"budget:"))
    return undefined;

  const outlets = outletPorts(scene,item);
  const attached = new Set<number>();
  const inputs: number[] = [];
  scene.connections.forEach((c, connection) => {
    const ports = [c.from, c.to, ...scene.parts.filter(p => p.connection === connection).flatMap(p => [p.entry, p.exit])]
      .filter(p => outlets.has(p));
    if (!ports.length) return;
    ports.forEach(p => attached.add(p));
    inputs.push(c.evidence);
  });
  // 구분자가 포함된 포트 ID도 조합 키에서 구별한다.
  const combination = [...attached].map(p => encodeURIComponent(scene.ports[p]!.id)).sort().join("+");
  const row = effectiveClaim(scene, "item", item, POWER, "budget:" + combination + ":" + encodeURIComponent(id));
  if (row !== undefined) inputs.push(row);
  const value = row === undefined ? null : readClaim(scene,row).value as number | null;
  return { value, inputs };
}
