// Windows 측정 파일의 경계를 검증한다. 읽지 못한 값과 실제 0은 별도 행 상태다.
import { z } from "zod";

const id = z.string().min(1);
export const readingNames = {
  tree:"장치 나무", usbParent:"USB 부모 허브", usbMode:"USB 협상 모드", linkSpeed:"NIC 회선 속도",
  pcieGeneration:"현재 PCIe 세대", pcieWidth:"현재 PCIe 폭", displayMode:"현재 화면 모드",
  connector:"화면 커넥터", outputGpu:"출력 GPU", bitDepth:"색 깊이", edid:"EDID", batteryRate:"배터리 충방전",
} as const;
const kind = z.enum(Object.keys(readingNames) as [keyof typeof readingNames, ...(keyof typeof readingNames)[]]);
const units = { tree:"",usbParent:"",usbMode:"",linkSpeed:"Mbps",pcieGeneration:"",pcieWidth:"lanes",displayMode:"",
  connector:"",outputGpu:"",bitDepth:"bpc",edid:"",batteryRate:"W" } as const;
const reading = z.strictObject({device:id.nullable(), kind, value:z.union([id,z.number()]).nullable(), unit:z.string(), reason:id.optional(), medium:z.literal("802.3").optional()})
  .superRefine((row,ctx) => {
    if (row.medium && row.kind !== "linkSpeed") ctx.addIssue({code:"custom",path:["medium"],message:"회선 속도에서만 매체를 지정합니다"});
    if (row.unit !== units[row.kind]) ctx.addIssue({code:"custom",path:["unit"],message:"측정량의 단위와 다릅니다"});
    if ((row.value === null) !== !!row.reason) ctx.addIssue({code:"custom",path:["reason"],message:"수집하지 못한 항목에는 이유가 필요합니다"});
    if (row.value === null) return;
    if (row.kind === "displayMode" && (typeof row.value !== "string" ||
      !/^[1-9]\d*×[1-9]\d*@(?:0\.\d*[1-9]\d*|[1-9]\d*(?:\.\d+)?)$/.test(row.value)))
      ctx.addIssue({code:"custom",path:["value"],message:"화면 모드는 가로×세로@주사율이어야 합니다"});
    const numeric = ["linkSpeed","pcieGeneration","pcieWidth","bitDepth","batteryRate"].includes(row.kind);
    if (numeric !== (typeof row.value === "number") || (typeof row.value === "number" && row.kind !== "batteryRate" && row.value <= 0))
      ctx.addIssue({code:"custom",path:["value"],message:"측정값의 종류 또는 부호가 다릅니다"});
  });
export const captureFile = z.strictObject({
  version:z.literal(1), capturedAt:z.iso.datetime({offset:true}), osBuild:id,
  devices:z.array(z.strictObject({id,name:id,parent:id.nullable(),children:z.array(id),locations:z.array(id),
    hardwareIds:z.array(id),driver:id.nullable()})), readings:z.array(reading),
}).superRefine((file,ctx) => {
  const devices = new Set<string>();
  file.devices.forEach((d,i) => {
    if (devices.has(d.id)) ctx.addIssue({code:"custom",path:["devices",i,"id"],message:"중복 장치 ID"});
    devices.add(d.id);
  });
  for (const [i,r] of file.readings.entries()) if (r.device !== null && !devices.has(r.device))
    ctx.addIssue({code:"custom",path:["readings",i,"device"],message:"장치 표에 없는 ID"});
});
export type Capture = z.infer<typeof captureFile>;

export type MeasurementPort = {instanceId:string; id:string; firmware?:string|null|undefined; measurementCondition?:string|null|undefined};
export type Match = {key:string; label:string; ports:MeasurementPort[]; applied:boolean};
export type Preview = {captureId:string; capture:Capture; etag:string; rows:{row:number; candidates:Match[]}[]};
