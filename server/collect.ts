// 수집 원본을 보관하고 사용자가 확인한 배선과 실물에만 검증값을 붙인다.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { captureFile, type Capture, type Match } from "../collector/capture.ts";
import { domains, plugins } from "../domains/registry.ts";
import { loadSceneDocuments } from "../scene/load.ts";
import { measurementPorts, measurementPrediction, recordMeasurement, verificationLocator, type MeasurementTarget } from "../scene/measurement.ts";
import { sceneFile } from "../scene/files.ts";
import { LibraryError, type openLibrary, sceneIdPattern, writeAtomic } from "./library.ts";

type Scene = z.input<typeof sceneFile>;
type Connection = Scene["connections"][number];
type Port = NonNullable<Connection["observations"]>[number]["ports"][number];
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const sceneId = z.string().regex(sceneIdPattern);
const known = z.string().trim().min(1).nullable();
const context = z.strictObject({instanceId:z.string().min(1), firmware:known, measurementCondition:known});
const request = z.union([
  z.strictObject({sceneId,capture:captureFile}),
  z.strictObject({sceneId,captureId:hash,picks:z.array(z.strictObject({row:z.int().nonnegative(),key:hash})),
    contexts:z.array(context).default([])}),
]);

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function collect(dataDir: string, library: ReturnType<typeof openLibrary>, body: unknown, ifMatch?: string) {
  const checked = request.safeParse(body);
  if (!checked.success) throw new LibraryError(422,"capture",checked.error.issues[0]!.message);
  const input = checked.data;
  const saved = library.readScene(input.sceneId);
  if (!saved) throw new LibraryError(404,"sceneId","장면을 찾을 수 없습니다");
  const applying = "picks" in input;
  if (applying && ifMatch !== saved.etag)
    throw new LibraryError(ifMatch ? 412 : 428,"If-Match","장면이 바뀌었습니다. 수집 파일을 다시 열어 맞춤을 확인하세요.");
  const captureId = applying ? input.captureId : digest(input.capture);
  const path = join(dataDir,"collect",captureId+".json");
  let capture: Capture;
  if (applying) {
    if (!existsSync(path)) throw new LibraryError(404,"captureId","가져온 수집 파일이 없습니다");
    capture = captureFile.parse(JSON.parse(readFileSync(path,"utf8")));
    if (digest(capture) !== captureId) throw new LibraryError(409,"captureId","보관한 수집 파일의 내용이 달라졌습니다");
  } else {
    capture = input.capture;
    if (!existsSync(path)) writeAtomic(path,JSON.stringify(capture,null,2)+"\n",true);
  }
  const scene: Scene = JSON.parse(saved.text);
  const catalog = library.describe();
  const models = new Map(catalog.models.map(m => [m.modelId+"@"+m.revision,m]));
  const devices = new Map(capture.devices.map(d => [d.id,d]));
  const picks = new Map(applying ? input.picks.map(p => [p.row,p.key]) : []);
  const contexts = new Map(applying ? input.contexts.map(c => [c.instanceId,c]) : []);
  const usedContexts = new Set<string>();
  if (applying && (picks.size !== input.picks.length || contexts.size !== input.contexts.length))
    throw new LibraryError(422,"picks","같은 측정 행이나 실물 조건을 두 번 골랐습니다");

  let document = contexts.size ? {...scene,items:scene.items.map(i => {
    const context = contexts.get(i.instanceId);
    return context ? {...i,...context} : i;
  })} : scene;
  const beforeMeasurement = document;
  let baseline: ReturnType<typeof loadSceneDocuments> | undefined;
  let additions = 0;
  const rows = capture.readings.map((r,row) => {
    const candidates: Match[] = [];
    const device = r.device && devices.get(r.device);
    const fact = {value:r.value,unit:r.unit};
    const domain = r.kind === "usbParent" ? "data" : r.kind === "outputGpu" ? "display"
      : domains.find(d => d.quests?.some(q => q.field === r.kind && q.observation?.schema.safeParse({[r.kind]:fact}).success))?.plugin.id;
    if (r.kind === "linkSpeed" && r.medium !== "802.3") return {row,candidates};
    if (!device || !domain || r.value === null || r.kind === "usbParent" && r.value !== device.parent) return {row,candidates};

    for (const [connection,c] of scene.connections.entries()) {
      const ports = measurementPorts(c,scene.items);
      for (const ref of [ports[0]!,ports.at(-1)!]) {
        const item = scene.items.find(i => i.instanceId === ref.instanceId)!;
        const model = models.get(item.modelId+"@"+item.revision)!;
        const port = model.ports.find(p => p.id === ref.id)!;
        if (!port.interfaces.some(i => i.domain === domain && (domain !== "network" || i.protocol === "Ethernet")
          && (r.kind !== "outputGpu" || i.role === "source" || i.role === "bidirectional"))) continue;
        const nodes = r.kind === "outputGpu" || r.kind === "usbParent" ? model.nodes : [undefined];
        for (const node of nodes) {
          function matchKey(chain: Port[]) {
            return digest([c.id,chain,ref.instanceId,ref.id,node?.id ?? null]);
          }
          const key = matchKey(ports);
          const sourcePrefix = "collect-"+captureId+"-"+row+"-";
          const sourceId = sourcePrefix+key;
          const label = [item.alias || model.name,item.instanceId+"/"+port.id,node && "내부 "+node.label,c.id].filter(Boolean).join(" · ");
          const applied = node ? scene.personal?.some(p => p.instanceId === ref.instanceId && p.ownerId === ref.id && p.field === "attachment" && p.claim.sources.includes(sourceId))
            : c.observations?.some(o => o.domain === domain && o.field === r.kind && o.claim.sources.includes(sourceId));
          candidates.push({key,label,ports,applied:!!applied});
          if (picks.get(row) !== key) continue;
          picks.delete(row);
          const measured = ports.map(p => {
            const supplied = contexts.get(p.instanceId);
            if (supplied) usedContexts.add(p.instanceId);
            const firmware = supplied ? supplied.firmware : p.firmware;
            const measurementCondition = supplied ? supplied.measurementCondition : p.measurementCondition;
            if (firmware === undefined || measurementCondition === undefined ||
              p.firmware !== undefined && p.firmware !== firmware ||
              p.measurementCondition !== undefined && p.measurementCondition !== measurementCondition)
              throw new LibraryError(422,"contexts","배선에 있는 각 실물의 현재 펌웨어와 측정 조건을 확인하세요");
            return {...p,firmware,measurementCondition};
          });
          if (applied) continue;
          const finalSource = sourcePrefix+matchKey(measured);
          const target:MeasurementTarget = node ? {instanceId:item.instanceId,ownerKind:"port",ownerId:port.id,domain:"",field:"attachment"}
            : {connection,domain,field:r.kind};
          const metadata = new URLSearchParams({ os: "Windows " + capture.osBuild, driver: device.driver ?? "미확인",
            note: "수집 원본 collect/" + captureId + ".json#readings/" + row + " · " + capture.capturedAt });
          const source = { id:finalSource, title:"수집기", retrievedAt:capture.capturedAt.slice(0,10), locator:verificationLocator(metadata) };
          baseline ??= loadSceneDocuments(beforeMeasurement, { connectors:catalog.connectors, models }, plugins);
          const value = { value:node?.id ?? r.value, unit:r.unit };
          const prediction = measurementPrediction(baseline, target, value.unit);
          const next = recordMeasurement(document, target, value, source, "capture", prediction);
          if (!next) throw new LibraryError(409,"picks","같은 대상·조건의 기존 측정과 값이 다릅니다. 장면에서 기존 측정과 수집 당시 조건을 확인하세요.");
          document = next;
          additions++;
        }
      }
    }
    return {row,candidates};
  });
  if (picks.size || usedContexts.size !== contexts.size) throw new LibraryError(422,"picks","측정량·대상·배선·조건이 일치하지 않는 맞춤입니다");
  if (applying) {
    const id = additions ? library.saveScene(scene.sceneId,document,saved.etag).id : scene.sceneId;
    return {id,additions};
  }
  return {captureId,capture,etag:saved.etag,rows};
}
