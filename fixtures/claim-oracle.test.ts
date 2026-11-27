// 제품 장면에서 주장 하나 또는 한 쌍을 미확인으로 바꿔 작업·목표를 고정 세계의 합과 대조한다.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { loadScene } from "../cli/load.ts";
import { plugins } from "../domains/registry.ts";
import { compareQuantity, effectiveClaim, readClaim, type Claim, type DomainPlugin, type Scene, type Value } from "../engine/contract.ts";
import { evaluate } from "../engine/evaluate.ts";
import { availableOption } from "../engine/pools.ts";
import type { Results } from "../engine/results.ts";
import type { Goal } from "../engine/scene.ts";
import { loadSceneDocuments } from "../scene/load.ts";
import { trialDomain } from "./trial.ts";

// 평소에도 모든 제품 장면을 돌리고, 전체 검산 때에는 각 주장의 유한 격자까지 전부 돈다.
const ORACLE_SHARDS = 16;
const shard = process.env.BENCHWIRE_ORACLE_SHARD ?? "0";
assert.ok(shard==="all" || /^(0|[1-9]\d*)$/.test(shard) && Number(shard)<ORACLE_SHARDS);

function read(dir:string, name:string) {
  return JSON.parse(readFileSync("fixtures/"+dir+"/"+name+".json","utf8"));
}

function fixed(scene:Scene, row:number, value:Value):Scene {
  const claims=scene.claims.slice(), c={...claims[row]!,value};
  if (value===null) c.confidence="unknown";
  if (c.connectorRow!==undefined) c.connectorRow=value===null ? null : scene.connectors.findIndex(v=>v.id===value);
  if (c.attachmentNode!==undefined) c.attachmentNode=value===null ? null :
    scene.nodes.findIndex(n=>n.item===scene.ports[c.owner]!.item && n.id===value);
  claims[row]=c;
  const members=scene.members.map(m=>{
    if (m.evidence!==row) return m;
    const {priority:_,...rest}=m;
    return typeof value==="number" ? {...rest,priority:value} : rest;
  });
  return {...scene,claims,members};
}

function fieldTypes(schema:unknown, path:string[]):z.ZodType[] {
  if (schema instanceof z.ZodNullable || schema instanceof z.ZodOptional || schema instanceof z.ZodDefault)
    return fieldTypes(schema.unwrap(),path);
  if (schema instanceof z.ZodUnion) return schema.options.flatMap(s=>fieldTypes(s,path));
  if (!path.length) return schema instanceof z.ZodType ? [schema] : [];
  if (schema instanceof z.ZodRecord) return fieldTypes(schema.valueType,path.slice(1));
  if (schema instanceof z.ZodObject) return fieldTypes(schema.shape[path[0]!] ?? schema.def.catchall,path.slice(1));
  return [];
}

function space(scene:Scene,c:Claim,domains:readonly DomainPlugin[]) {
  // 저장 형식은 명시적인 우선순위에 정수만 허용한다. 생략한 순위와 값 미확인은 다른 장면이다.
  if (c.ownerKind==="workload" && !c.domain && c.field==="priority") {
    const ranks=scene.members.filter(m=>scene.scenarios[m.scenario]!.id===c.condition && m.priority!==undefined).map(m=>m.priority!);
    return {exact:true,values:[...new Set([Math.min(...ranks)-1,Math.max(...ranks)+1].filter(Number.isSafeInteger))]};
  }
  if (c.connectorRow!==undefined) return {exact:true,values:scene.connectors.map(v=>v.id)};
  if (c.attachmentNode!==undefined) return {exact:true,values:scene.nodes.filter(n=>n.item===scene.ports[c.owner]!.item).map(n=>n.id)};
  if (c.domain==="power" && c.field==="sourceNode" && c.ownerKind==="interface") {
    const item=scene.ports[scene.interfaces[c.owner]!.port]!.item;
    return {exact:true,values:["",...scene.nodes.filter(n=>n.item===item).map(n=>n.id)]};
  }
  if (c.domain==="network" && c.field==="budgetResource" && c.ownerKind==="interface") {
    const owner=scene.ports[scene.interfaces[c.owner]!.port]!.item;
    return {exact:true,values:scene.resources.filter(r=>r.item===owner && r.unit==="W" && r.domain==="network").map(r=>r.id)};
  }
  const plugin=domains.find(p=>p.id===c.domain);
  const schema=c.ownerKind==="item" ? plugin?.attributes : c.ownerKind==="workload" ? plugin?.request
    : c.ownerKind==="interface" ? plugin?.paramsFor?.(scene.interfaces[c.owner]!.protocol) ?? plugin?.params
    : c.ownerKind==="connection" ? plugin?.observations : undefined;
  const types=fieldTypes(schema,[c.field,"value"]);
  const candidates=new Set<Exclude<Value,null>>();
  let exact=true;
  for (const t of types) {
    if (t instanceof z.ZodBoolean) { candidates.add(true); candidates.add(false); }
    else if (t instanceof z.ZodLiteral || t instanceof z.ZodEnum) {
      for (const v of t instanceof z.ZodLiteral ? t.values : t.options)
        if (typeof v==="string" || typeof v==="number" || typeof v==="boolean") candidates.add(v);
    } else if (t instanceof z.ZodNumber) {
      const lo=t.minValue,hi=t.maxValue,json=t.toJSONSchema();
      const step=json.multipleOf ?? (t.isInt ? 1 : undefined);
      if (step && lo!==null && hi!==null && Number.isFinite(lo) && hi<Number.MAX_SAFE_INTEGER) {
        for (let i=Math.floor(lo/step);i<=Math.ceil(hi/step);i++) {
          const v=Number((i*step).toPrecision(15));
          if (t.safeParse(v).success) candidates.add(v);
        }
      } else {
        exact=false;
        for (const v of [0,lo,hi,...(typeof c.value==="number" ? [c.value,c.value/2,c.value*2] : [])])
          if (typeof v==="number" && Number.isFinite(v) && t.safeParse(v).success) candidates.add(v);
      }
    } else if (t instanceof z.ZodString) exact=false;
  }
  if (!candidates.size && c.discrete?.length) return {exact:true,values:[...c.discrete]};
  if (!candidates.size && typeof c.value==="number")
    return {exact:false,values:[...new Set([0,c.value,c.value/2,2*c.value])].filter(v=>c.field!=="priority" || Number.isInteger(v))};
  if (!candidates.size && (typeof c.value==="string" || c.value===null && types.some(t=>t instanceof z.ZodString))) {
    exact=false;
    for (const v of scene.claims.filter(k=>k.field===c.field && k.domain===c.domain).map(k=>k.value))
      if (typeof v==="string" && (!types.length || types.some(t=>t.safeParse(v).success))) candidates.add(v);
  }
  return {exact,values:[...candidates]};
}

function goals(scene:Scene, result:Results) {
  const goals:Goal[]=[];
  for (const scenario of scene.scenarios.keys()) {
    const workloads=scene.members.filter(m=>m.scenario===scenario).map(m=>m.workload);
    goals.push({scenario,id:scenario+"/전체",kind:"scenario"});
    if (workloads.length>1) scene.ports.forEach(({item},port)=>{
      goals.push({scenario,id:scenario+"/공유포트/"+port,kind:"port",item,port,workloads});
    });
  }
  for (const {scenario,workload} of scene.members) {
    const work=scene.workloads[workload]!, id=scenario+"/"+work.id, workloads=[workload];
    goals.push({id,scenario,kind:"workload",workload});
    const item=scene.nodes[work.from]!.item;
    scene.ports.forEach((p,port)=>{if (p.item===item) goals.push({id:id+"/port/"+port,scenario,kind:"port",item,port,workloads});});
    const row=result.outcomes.findIndex(o=>o.subjectKind==="workload" && o.subjectRow===workload && o.scenario===scenario);
    const quantities=[
      ...result.metrics.flatMap(m=>m.outcome===row && (m.kind==="together" || m.kind==="solo")
        ? [{...m,run:m.kind,kind:"delivery"} as const] : []),
      ...result.measures.filter(m=>m.outcome===row)];
    for (const {kind:metric,unit,run,low,high} of quantities)
      for (const minimum of new Set([low,high].filter((n):n is number=>n!==null)))
        goals.push({id:[id,metric,run,minimum].join("/"),scenario,kind:"metric",workloads,run,metric,unit,minimum});
  }
  return goals;
}

function observations(r:Results) {
  const verdicts=new Map<string,Set<string>>(), ranges=new Map<string,[number,number]>();
  function possible(i:number) {
    const verdict=r.outcomes[i]!.verdict;
    const published=new Set(r.possibleVerdicts.filter(v=>v.outcome===i).map(v=>v.verdict));
    if (verdict!=="unknown") {
      if (published.size) assert.deepEqual(published,new Set([verdict]));
      return new Set([verdict]);
    }
    return published.size && !published.has("unknown") ? published : new Set(["ok","conditional","impossible"]);
  }
  for (const [i,o] of r.outcomes.entries()) {
    if (o.subjectKind!=="workload") continue;
    const key=[o.scenario,o.subjectRow].join("/");
    verdicts.set(key,possible(i));
    for (const m of r.metrics.filter(m=>m.outcome===i && m.kind!=="unused"))
      ranges.set(key+"/"+m.kind,[m.low ?? -Infinity,m.high ?? Infinity]);
    for (const m of r.measures.filter(m=>m.outcome===i))
      ranges.set([key,m.kind,m.run].join("/"),[m.low ?? -Infinity,m.high ?? Infinity]);
  }
  for (const g of r.goals) verdicts.set("목표/"+g.id,new Set(g.verdict==="unknown" ? ["ok","impossible"] : [g.verdict]));
  const links=new Map<string,Map<string,{possible:Set<string>;low:number;high:number}>>();
  const scenarios=[...new Set(r.goals.map(g=>g.scenario))];
  for (const [i,o] of r.outcomes.entries()) if (o.subjectKind==="connection") {
    const limit=r.metrics.find(m=>m.outcome===i && m.kind==="limit");
    const option=o.option===undefined ? undefined : availableOption(r,o.option);
    const low=limit ? limit.low : option?.limit ?? option?.bounds?.low;
    const high=limit ? limit.high : option?.limit ?? option?.bounds?.high;
    const answer={
      possible:possible(i),
      low:o.verdict==="impossible" ? 0 : low ?? 0,high:o.verdict==="impossible" ? 0 : high ?? Infinity};
    for (const scenario of o.scenario===null ? scenarios : [o.scenario]) {
      const key=[scenario,o.subjectRow,o.direction,o.domain].join("/");
      const budgets=links.get(key) ?? new Map(); links.set(key,budgets);
      budgets.set([o.unit,o.pool?.domain,o.pool?.id].join("/"),answer);
    }
  }
  return {verdicts,ranges,links,truncated:new Set(r.goals.filter(g=>g.truncated).map(g=>g.scenario))};
}

function order(a:number,b:number) {
  return Number.isFinite(a) && Number.isFinite(b) ? compareQuantity(a,b) : a===b ? 0 : a<b ? -1 : 1;
}
// 같은 실물이나 연결을 공유하는 두 주장을 한 축 묶음으로 고른다. 각 묶음 안에서는 데카르트 곱 전부를 대조한다.
const MAX_PAIR_SAMPLES=16;
function* axes(scene:Scene, domains:readonly DomainPlugin[], only?: (c:Claim)=>boolean) {
  const all=scene.claims.flatMap((c,row)=>{
    if (c.inactive || only && !only(c)) return [];
    const domain=space(scene,c,domains);
    return domain.values.length ? [{row,c,...domain}] : [];
  });
  for (const axis of all) yield [axis];
  if (only) return;
  const groups=new Map<string,typeof all>();
  const add=(key:string,axis:typeof all[number])=>{const g=groups.get(key) ?? [];g.push(axis);groups.set(key,g);};
  for (const axis of all) {
    if (axis.values.length<2 || axis.values.length>MAX_PAIR_SAMPLES) continue;
    const {c}=axis,port=c.ownerKind==="interface" ? scene.interfaces[c.owner]!.port : c.ownerKind==="port" ? c.owner : undefined;
    const item=port!==undefined ? scene.ports[port]!.item : c.ownerKind==="item" ? c.owner :
      c.ownerKind==="resource" ? scene.resources[c.owner]!.item : undefined;
    if (item!==undefined) add("실물/"+item,axis);
    scene.connections.forEach((link,i)=>{
      const parts=scene.parts.filter(p=>p.connection===i);
      if (c.ownerKind==="connection" && c.owner===i || port!==undefined && [link.from,link.to,...parts.flatMap(p=>[p.entry,p.exit])].includes(port) ||
        item!==undefined && parts.some(p=>p.item===item)) add("연결/"+i,axis);
    });
  }
  const used=new Set<string>(),pairs=new Set<string>();
  for (const [key,group] of groups) {
    const choices=group.flatMap((a,i)=>group.slice(i+1).filter(b=>a.values.length*b.values.length<=MAX_PAIR_SAMPLES)
      .map(b=>({a,b,id:a.row+"/"+b.row,fields:[a.c.domain,a.c.field,b.c.domain,b.c.field].join("/")})));
    const best=choices.filter(p=>!pairs.has(p.id)).sort((p,q)=>
      Number(used.has(p.fields))-Number(used.has(q.fields)) ||
      Number(!p.a.c.domain || !p.b.c.domain)-Number(!q.a.c.domain || !q.b.c.domain) ||
      (key.startsWith("연결") ? Number(p.a.c.owner===p.b.c.owner)-Number(q.a.c.owner===q.b.c.owner) : 0))[0];
    if (best) { pairs.add(best.id);used.add(best.fields);yield [best.a,best.b]; }
  }
}
function oracle(scene:Scene, domains:readonly DomainPlugin[], only?: (c:Claim)=>boolean) {
  const base=goals(scene,evaluate(scene,domains));
  const failures:string[]=[];
  let eligible=0, cases=0, worlds=0;
  let pairs=0;
  for (const group of axes(scene,domains,only)) {
    if (!only && shard!=="all" && eligible++ % ORACLE_SHARDS!==Number(shard)) continue;
    const [first,second]=group;
    const {row}=first!;
    if (second) pairs++;
    const exact=group.every(axis=>axis.exact);
    const values=first!.values.flatMap(a=>second ? second.values.map(b=>[a,b]) : [[a]]);
    const assign=(s:Scene,vs:Value[])=>group.reduce((prior,axis,i)=>fixed(prior,axis.row,vs[i]!),s);
    const targets=new Map(base.map(g=>[g.id,g]));
    const points=exact ? [values[0]!,values.at(-1)!] : values;
    for (const v of points) {
      const s=assign(scene,v);
      for (const g of goals(s,evaluate(s,domains))) targets.set(g.id,g);
    }
    const input={...scene,goals:[...targets.values()]};
    const disputed=assign(input,group.map(()=>null));
    for (const axis of group) if (!axis.c.domain && axis.c.field==="priority") {
      const origin=scene.claimSources.find(s=>s.claim===axis.row)!;
      disputed.claimSources=[...disputed.claimSources,...axis.values.map((value,i)=>({
        claim:axis.row,source:i ? disputed.sources.length : origin.source,candidate:{value,confidence:"review" as const}}))];
      disputed.sources=[...disputed.sources,{...scene.sources[origin.source]!,id:"순위-대조-"+axis.row}];
    }
    const unknown=evaluate(disputed,domains);
    const actual=observations(unknown);
    const samples=values.map(v=>observations(evaluate(assign(input,v),domains)));
    const blocked={possible:new Set(["impossible"]),low:0,high:0};
    const incomplete={possible:new Set(["ok","conditional","impossible"]),low:0,high:Infinity};
    for (const key of new Set([actual,...samples].flatMap(s=>[...s.links.keys()]))) {
      const budgets=new Set([actual,...samples].flatMap(s=>[...s.links.get(key)?.keys() ?? []]));
      if (budgets.size>1) budgets.delete("//");
      for (const s of [actual,...samples]) for (const id of budgets) {
        const rows=s.links.get(key);
        const scenario=Number(key.split("/")[0]);
        const link=rows?.get(id) ?? rows?.get("//") ?? (s.truncated.has(scenario) ? incomplete : blocked);
        const name="연결/"+key+"/"+id;
        s.verdicts.set(name,new Set(link.possible));
        s.ranges.set(name,[link.low,link.high]);
      }
    }
    const expected=samples[0]!;
    for (const sample of samples.slice(1)) {
      for (const [key,possible] of sample.verdicts) for (const verdict of possible) expected.verdicts.get(key)!.add(verdict);
      for (const [key,[low,high]] of sample.ranges) {
        const prior=expected.ranges.get(key);
        expected.ranges.set(key,prior ? [Math.min(prior[0],low),Math.max(prior[1],high)] : [low,high]);
      }
    }
    cases++; worlds+=values.length;
    const errors:string[]=[];
    for (const [key,wanted] of expected.verdicts) {
      const got=actual.verdicts.get(key)!;
      if (!wanted.isSubsetOf(got) || exact && got.size!==wanted.size)
        errors.push(key+" "+[...wanted]+" → "+[...got]);
      if (only && key.startsWith("목표/") && wanted.size>1) {
        const goal=unknown.goals.findIndex(g=>"목표/"+g.id===key);
        if (!unknown.goalEvidence.some(e=>e.goal===goal && e.claims.includes(row) &&
          unknown.quests.some(q=>q.outcome===e.outcome && q.claim===row))) errors.push(key+" 미확인 주장의 근거·퀘스트 누락");
      }
    }
    for (const [key,[lo,hi]] of expected.ranges) {
      const got=actual.ranges.get(key);
      if (!got || order(got[0],lo)>0 || order(got[1],hi)<0 ||
          exact && (order(got[0],lo)!==0 || order(got[1],hi)!==0))
        errors.push(key+" ["+[lo,hi]+"] → ["+got+"]");
    }
    if (errors.length) failures.push(group.map(a=>a.row+" "+a.c.ownerKind+"."+a.c.owner+"."+a.c.field).join(" + ")+" | "+errors.join(" · "));
  }
  assert.ok(cases>0);
  assert.equal(failures.length,0,"주장 "+cases+"개 · 고정 세계 "+worlds+"개\n"+failures.join("\n"));
  return "단일 "+(cases-pairs)+"개 · 쌍 "+pairs+"개 · 고정 세계 "+worlds+"개";
}

for (const behavior of ["운전 중에만 집계","구간에서는 생략","중간에서 최대"] as const)
  test("T10 "+behavior+"하는 품질과 작업 판정을 배분 용량의 고정 세계와 대조한다",()=>{
    const p=trialDomain(), scene=loadScene("fixtures/three-flows.json",{modelsDir:"fixtures",connectorsFile:"fixtures/connectors.json"},[p]);
    scene.members.length=scene.workloads.length=scene.connections.length=1;
    const row=effectiveClaim(scene,"resource",0,p.id,"capacity")!;
    p.goalMeasures=[{kind:"품질",label:"품질",unit:"점"}];
    p.assess=(_s,_w,_d,_steps,{low,high})=>{
      const middle=low===50 && high===50;
      const score=behavior==="중간에서 최대" ? middle ? 150 : 25 : 100;
      const present=behavior==="운전 중에만 집계" ? high!==null && high>=50 : behavior==="중간에서 최대" || low===high;
      return {rule:"시험 품질",inputs:[],specs:[],possible:[middle ? "impossible" : "ok"],
        metrics:present ? [{kind:"품질",unit:"점",low:behavior==="운전 중에만 집계" && (low===null || low<50) ? null : score,high:score}] : []};
    };
    scene.goals=[
      {id:"작업",kind:"workload",scenario:0,workload:0},{id:"전체",kind:"scenario",scenario:0},
      {id:"포트",kind:"port",scenario:0,item:scene.ports[scene.connections[0]!.from]!.item,port:scene.connections[0]!.from,workloads:[0]},
      ...(["solo","together"] as const).flatMap(run=>[
        {id:run+" 품질",kind:"metric" as const,scenario:0,workloads:[0],run,metric:"품질",unit:"점",minimum:101},
        {id:run+" 전달",kind:"metric" as const,scenario:0,workloads:[0],run,metric:"delivery",unit:"회/s",minimum:101}])];
    const run=(s:Scene)=>evaluate(s,[p]);
    const points=[0,50,100], samples=points.map(n=>run(fixed(scene,row,n)));
    const open=fixed(scene,row,null), unknown=run(open);
    for (const [i,g] of unknown.goals.entries()) {
      if (g.id.endsWith(" 전달")) {
        assert.deepEqual([g.verdict,g.truncated],["impossible",false]);
        const evidence=unknown.goalEvidence.find(e=>e.goal===i)!;
        assert.deepEqual([evidence.low,evidence.high],[0,100]);
      } else {
        assert.deepEqual([g.verdict,g.truncated,g.openClaims,g.limitClaims],["unknown",true,[row],undefined],g.id);
        const evidence=unknown.goalEvidence.find(e=>e.goal===i)!;
        assert.deepEqual([evidence.low,evidence.high],[null,null]);
        assert.ok(evidence.reasons.length && evidence.claims.includes(row) && unknown.quests.some(q=>q.outcome===evidence.outcome && q.claim===row));
      }
    }
    const quality=samples.map(s=>s.goals.find(g=>g.id==="together 품질")!.verdict);
    assert.deepEqual(quality,behavior==="중간에서 최대" ? ["impossible","ok","impossible"] :
      behavior==="구간에서는 생략" ? ["impossible","impossible","impossible"] : ["unknown","impossible","impossible"]);
    open.claims[row]!.discrete=points;
    const finite=run(open);
    assert.ok(finite.goals.every(g=>!g.openClaims && !g.limitClaims));
    assert.deepEqual(new Set(finite.profileWorlds.map(w=>w.value)),new Set(points));
    assert.deepEqual(finite.goals.map(g=>[g.verdict,g.truncated]),samples[0]!.goals.map((g,i)=>
      [samples.every(r=>r.goals[i]!.verdict===g.verdict) ? g.verdict : "unknown",false]));
  });

test("T10 이웃의 미확인 매체 용량이 동시 배분에만 영향을 주면 단독 품질은 확정한다",()=>{
  const p=trialDomain();
  p.goalMeasures=[{kind:"품질",unit:"점",label:"품질"}];
  p.assess=()=>({rule:"시험 품질",inputs:[],specs:[],possible:["ok"],metrics:[{kind:"품질",unit:"점",low:100,high:100}]});
  let scene=loadScene("fixtures/three-flows.json",{modelsDir:"fixtures",connectorsFile:"fixtures/connectors.json"},[p]);
  scene.members.length=scene.workloads.length=scene.connections.length=2;
  const resource=(item:string)=>scene.resources.findIndex(r=>scene.items[r.item]!.id===item);
  scene=fixed(scene,effectiveClaim(scene,"resource",resource("host"),p.id,"capacity")!,100);
  const claim=effectiveClaim(scene,"resource",resource("b"),p.id,"capacity")!;
  scene.goals=(["solo","together"] as const).map(run=>({id:run,scenario:0,kind:"metric",workloads:[0],run,metric:"품질",unit:"점",minimum:100}));
  const result=evaluate(fixed(scene,claim,null),[p]);
  assert.deepEqual(result.goals.map(g=>[g.verdict,g.truncated]),[["ok",false],["unknown",true]]);
  const evidence=result.goalEvidence.find(e=>e.goal===1)!;
  assert.ok(evidence.claims.includes(claim) && result.quests.some(q=>q.outcome===evidence.outcome && q.claim===claim));
});

// 제품 장면과 같은 오라클에 두 설정이 실제로 경쟁하는 검토 반례도 넣는다.
test("T7 공유 송전 예산에서 선순위 케이블 손실을 모르는 세계",()=>{
  const dir="network",doc=read(dir,"scene"),pse=read(dir,"network-pse@1"),wire=read(dir,"network-copper@1");
  const port=structuredClone(pse.ports[0]);
  for (const iface of port.interfaces) iface.id+="-first";
  port.id="first"; pse.ports.push(port); pse.resources[0].capacity.value=43;
  const original=doc.connections.find((c:{id:string})=>c.id==="poe");
  doc.items=doc.items.filter((i:{instanceId:string})=>["pse","pd","poe-wire"].includes(i.instanceId));
  doc.items.push({instanceId:"first-pd",modelId:"network-pd",revision:"1"},{instanceId:"first-wire",modelId:"network-copper",revision:"1"});
  doc.connections=[original,{...original,id:"first",from:{instanceId:"pse",id:"first"},to:{instanceId:"first-pd",id:"pd"},
    parts:[{...original.parts[0],instanceId:"first-wire"}]}];
  const later=doc.workloads.find((w:{id:string})=>w.id==="poe-12");
  later.request.watts.value=20;
  doc.workloads=[later,{...later,id:"first",to:{...later.to,instanceId:"first-pd"}}];
  doc.scenarios=[{id:"shared",members:["first",later.id].map((workload,i)=>({workload,priority:{...original.evidence,value:i+1}}))}];
  const scene=loadSceneDocuments(doc,{connectors:read(dir,"connectors"),models:new Map([
    ["network-pse@1",pse],["network-copper@1",wire],["network-pd@1",read(dir,"network-pd@1")]])},plugins);
  const row=scene.claims.findIndex(c=>c.field==="poeLoss" && scene.items[c.owner]!.id==="first-wire");
  assert.deepEqual([1,2].map(loss=>evaluate(fixed(scene,row,loss),plugins).allocations.find(a=>a.workload===0 && a.run==="together")?.value),[20,0]);
  oracle(scene,plugins,c=>c===scene.claims[row]);
});

for (const partial of [false,true]) test("T10 정책표를 읽고 "+(partial ? "다른 작업의 한도만 반환한" : "한도를 정하지 못한")+" 서비스의 선택 세계",()=>{
  const plugin=trialDomain(), {negotiate,consume}=plugin;
  const doc=read(".","three-flows"),host=read(".","source@1");
  host.attributes={trial:{"budget:a:a:a":{...host.ports[0].interfaces[0].params.rate,value:100}}};
  host.resources[0].policy.value="port-table";
  doc.connections.length=doc.workloads.length=partial ? 2 : 1; doc.scenarios[0].members=partial ? ["a","b"] : ["a"];
  if (partial) {
    doc.workloads[1].request.rate.value=30;
    plugin.policy=({scene,resource,activeWorkloads})=>activeWorkloads.flatMap(workload=>{
      const value=scene.workloads[workload]!.id==="b" ? 30 : scene.claims[effectiveClaim(scene,"item",scene.resources[resource]!.item,"trial","budget:a:a:a")!]!.value;
      return typeof value==="number" ? [{workload,limit:value,inputs:[],rule:"작업별 한도",specs:[]}] : [];
    });
  }
  plugin.negotiate=l=>l.connection!==0 ? negotiate(l) : negotiate(l).flatMap(o=>[100,80].map(limit=>({...o,profile:String(limit),limit})));
  plugin.consume=(s,w,steps,d,options)=>s.workloads[w]!.id==="b" || steps.some(v=>v.option!==null && options[v.option]!.profile==="100") ? consume(s,w,steps,d,options) : [];
  const models=new Map<string,unknown>(doc.items.map((i:{modelId:string;revision:string})=>{
    const key=i.modelId+"@"+i.revision;
    return [key,i.modelId==="source" ? host : read(".",key)];
  }));
  const scene=loadSceneDocuments(doc,{models,connectors:read(".","connectors")},[plugin]);
  const row=scene.claims.findIndex(c=>c.field==="budget:a:a:a");
  assert.deepEqual([10,100].map(limit=>evaluate(fixed(scene,row,limit),[plugin]).allocations.find(a=>a.run==="together")?.value),[80,100]);
  oracle(scene,[plugin],c=>c.field==="budget:a:a:a");
});

test("T10 작업별 정책 한도에서도 고정 예약 구간을 양 끝까지 차감한다",()=>{
  const plugin=trialDomain(), {consume}=plugin;
  const scene=loadScene("fixtures/three-flows.json",{modelsDir:"fixtures",connectorsFile:"fixtures/connectors.json"},[plugin]);
  scene.members=scene.members.slice(0,1);
  const policy=scene.claims.find(c=>c.ownerKind==="resource" && c.field==="policy")!;
  policy.value="port-table";
  const cost=scene.claims.push({...policy,field:"reservation",value:40,openDomain:true})-1;
  plugin.policy=({activeWorkloads})=>activeWorkloads.map(workload=>({workload,limit:100,rule:"작업별 상한",inputs:[],specs:[]}));
  plugin.consume=(s,w,steps,d,opts)=>consume(s,w,steps,d,opts).map(u=>{
    const value=s.claims[cost]!.value as number|null;
    return {...u,fixed:value ?? 0,...(value===null && {fixedHigh:100}),inputs:[...u.inputs,cost]};
  });
  oracle(scene,[plugin],c=>c===scene.claims[cost]);
});

function sharedPowerScene(name:string) {
  const dir="fixtures/shared-power";
  return loadScene(dir+"/"+name+".json",{modelsDir:dir,connectorsFile:dir+"/connectors.json"},plugins);
}

test("T7 같은 실물 두 송전 포트의 예산 참조를 함께 고정해 후순위 목표와 대조한다",()=>{
  const scene=sharedPowerScene("poe"),refs=scene.claims.flatMap((c,row)=>c.field==="budgetResource" ? [row] : []);
  const [a,b]=refs.slice(1);
  const ref=scene.claims[a!]!;
  const network=plugins.find(p=>p.id===ref.domain)!;
  assert.deepEqual([...network.profileValues!(ref,scene)].sort(),["other-budget","port-budget"]);
  const later=scene.workloads.findIndex(w=>w.id==="pse");
  scene.goals=[{kind:"workload",id:"후순위",workload:later,scenario:0}];
  for (const [v,w,expected] of [["port-budget","port-budget","impossible"],["other-budget","port-budget","ok"],
    ["port-budget","other-budget","ok"],["other-budget","other-budget","ok"],[null,"port-budget","unknown"],
    ["other-budget",null,"ok"],[null,null,"unknown"]] as const) {
    const result=evaluate(fixed(fixed(scene,a!,v),b!,w),plugins);
    assert.equal(result.goals[0]!.verdict,expected,[v,w].join("/"));
    if (v===null && w===null) for (const ref of [a!,b!]) assert.ok(result.goalEvidence[0]!.claims.includes(ref));
  }
});

test("T7 한 실물의 예약 우선순위 출처 충돌을 양 끝의 고정 순서와 대조한다",()=>{
  const scene=sharedPowerScene("poe");
  const member=scene.members.find(m=>m.scenario===0 && m.priority===1)!;
  oracle(scene,plugins,c=>c===scene.claims[member.evidence!]);
});

test("T8 직렬 허브의 독립 전원 주장을 가능한 모든 공급 노드와 대조한다",t=>{
  const dir="power",doc=read(dir,"serial-passthrough");
  const models=new Map<string,ReturnType<typeof read>>();
  for (const {modelId,revision} of doc.items) {
    const key=modelId+"@"+revision;
    models.set(key,read(dir,key));
  }
  const relay=structuredClone(models.get("relay@1"));
  relay.modelId="independent-relay";
  const params=relay.ports[1].interfaces[0].params;
  params.sourceNode={value:null,unit:"",confidence:"unknown",sources:["relay"]};
  doc.items.find((i:{instanceId:string})=>i.instanceId==="relay-a").modelId=relay.modelId;
  models.set(relay.modelId+"@1",relay);
  const scene=loadSceneDocuments(doc,{models,connectors:read(dir,"connectors")},plugins);
  t.diagnostic("독립 전원 "+oracle(scene,plugins,c=>c.field==="sourceNode"));
});

test("T8 공유 전력 경로에 패스스루를 추가하면 10 W 상시 부하를 같은 예산에 예약한다",t=>{
  const dir="shared-power",doc=read(dir,"mixed");
  const models=new Map<string,unknown>(doc.items.map((i:{modelId:string})=>[i.modelId+"@1",read(dir,i.modelId+"@1")]));
  for (const [id,modelId] of [["relay","relay"],["usb-wire","cable-3a"]] as const) {
    models.set(modelId+"@1",read("power",modelId+"@1"));
    doc.items.push({instanceId:id,modelId,revision:"1"});
  }
  const usb=doc.connections.find((c:{id:string})=>c.id==="usb");
  doc.connections.push({...structuredClone(usb),id:"출력",from:{instanceId:"relay",id:"out"}});
  usb.to={instanceId:"relay",id:"in"};
  usb.parts=[{instanceId:"usb-wire",entry:"first",exit:"second"}];
  const scene=loadSceneDocuments(doc,{models,connectors:read(dir,"connectors")},plugins);
  scene.goals=[{id:"40 W",scenario:0,kind:"metric",workloads:[1],metric:"delivery",unit:"W",run:"together",minimum:40}];
  const r=evaluate(scene,plugins);
  assert.deepEqual([r.allocations.find(a=>a.scenario===0 && a.workload===1 && a.run==="together")!.value,r.goals[0]!.verdict],[33,"impossible"]);
  assert.ok(r.standingLoads.some(l=>l.kind==="scene" && l.amount===10 && scene.resources[l.resource]!.domain==="network"));
  t.diagnostic("상시 부하 "+oracle(scene,plugins));
});

test("T10 협상에서 다른 서비스가 구간을 내도 열린 수로 고르는 빠른 모드는 선택 입력이다",()=>{
  const plugin=trialDomain(), {negotiate,demand}=plugin;
  const scene=loadScene("fixtures/three-flows.json",{modelsDir:"fixtures",connectorsFile:"fixtures/connectors.json"},[plugin]);
  scene.members=scene.members.slice(0,1);
  const template=scene.claims[scene.connections[0]!.evidence]!;
  const row=scene.claims.push({...template,ownerKind:"item",owner:0,domain:plugin.id,field:"threshold",value:null,openDomain:true})-1;
  scene.claimSources.push({...scene.claimSources.find(s=>s.claim===scene.connections[0]!.evidence)!,claim:row});
  plugin.negotiate=l=>negotiate(l).flatMap(o=>{
    const value=readClaim(l.scene,row).value;
    return [{...o,mode:"safe",limit:80},{...o,mode:"unused",limit:null,bounds:{low:0,high:5}},
      ...(typeof value==="number" && value>=90 ? [{...o,mode:"fast",limit:100}] : [])];
  });
  plugin.demand=(s,w)=>demand(s,w).flatMap(d=>[{...d,mode:"fast"},{...d,mode:"safe",preference:1}]);
  scene.goals=[{id:"90",kind:"metric",scenario:0,workloads:[0],run:"together",metric:"delivery",unit:"회/s",minimum:90}];
  for (const [value,want] of [[10,"impossible"],[100,"ok"],[null,"unknown"]] as const) {
    const r=evaluate(fixed(scene,row,value),[plugin]);
    assert.equal(r.goals[0]!.verdict,want);
    if (value===null) assert.ok(r.goalEvidence[0]!.claims.includes(row));
  }
});

test("T8 USB PD와 PoE가 같은 실물의 65 W 예산을 쓰면 단독 60 W가 동시 43 W가 된다",()=>{
  const scene=sharedPowerScene("mixed"), rows=evaluate(scene,plugins).allocations;
  assert.deepEqual(rows.filter(a=>a.workload===1 && a.run==="together").map(a=>a.value),[43,60]);
});

test("T7 선순위 채널 손실이 미확인이면 후순위의 20 W 단독 대비 감소량과 감소율도 범위로 남긴다",()=>{
  const scene=sharedPowerScene("poe");
  const row=scene.claims.findIndex(c=>c.field==="poeLoss" && scene.items[c.owner]!.id==="first-wire");
  const pending=fixed(scene,row,null);
  assert.ok(evaluate(pending,plugins).goals.every(g=>g.verdict==="unknown" && g.truncated));
  const result=evaluate({...pending,goals:[]},plugins);
  const outcome=result.outcomes.findIndex(o=>o.subjectKind==="workload" && o.scenario===0 && scene.workloads[o.subjectRow]!.id==="pse");
  for (const [kind,low,high] of [["solo",20,20],["together",0,20],["drop",0,20],["dropPercent",0,100]] as const) {
    const metric=result.metrics.find(m=>m.outcome===outcome && m.kind===kind)!;
    assert.deepEqual([metric.low,metric.high],[low,high],kind);
  }
});

test("T7 같은 포트의 두 작업과 시나리오 목표가 채널 Type에 따라 함께 달라진다",()=>{
  const scene=sharedPowerScene("poe");
  const row=scene.claims.findIndex(c=>c.ownerKind==="item" && scene.items[c.owner]!.id==="first-wire" && c.field==="poeType");
  for (const [type,expected] of [[2,"ok"],[1,"impossible"],[null,"unknown"]] as const) {
    const result=evaluate(fixed(scene,row,type),plugins);
    assert.deepEqual(result.goals.map(g=>g.verdict),[expected,expected]);
  }
});

test("T10 소비 행과 인용이 비어도 읽은 주장은 세계를 만들고 읽지 않은 인용은 선택을 바꾸지 않는다",()=>{
  const plugin=trialDomain(), {consume,negotiate}=plugin;
  const scene=loadScene("fixtures/three-flows.json",{modelsDir:"fixtures",connectorsFile:"fixtures/connectors.json"},[plugin]);
  scene.members=scene.members.slice(0,1);
  const cap=scene.claims.find(c=>c.ownerKind==="resource" && c.field==="capacity")!;
  cap.value=50;
  const base={...cap,ownerKind:"item" as const,value:null,confidence:"unknown" as const};
  const hidden=scene.claims.push({...base,field:"reserve",discrete:[false,true]})-1;
  const citation=scene.claims.push({...base,field:"citation",openDomain:true})-1;
  plugin.negotiate=l=>negotiate(l).map(o=>({...o,inputs:[...o.inputs,citation]}));
  plugin.consume=(s,w,steps,d,options)=>{
    const row=effectiveClaim(s,"item",cap.owner,plugin.id,"reserve")!;
    const reserve=readClaim(s,row).value;
    return reserve===true || typeof reserve==="number" && reserve>0 ? consume(s,w,steps,d,options).map(u=>({...u,inputs:[]})) : [];
  };
  scene.goals=[{id:"90",kind:"metric",scenario:0,workloads:[0],run:"together",metric:"delivery",unit:"회/s",minimum:90}];
  for (const [value,verdict] of [[false,"ok"],[true,"impossible"],[null,"unknown"]] as const) {
    const result=evaluate(fixed(scene,hidden,value),[plugin]);
    assert.deepEqual([result.goals[0]!.verdict,result.goals[0]!.truncated],[verdict,false]);
    if (value===null) assert.deepEqual([result.goalEvidence[0]!.low,result.goalEvidence[0]!.high],[50,100]);
  }
  // 어느 예산을 쓰는지가 열린 수에 달리고 소비 행도 없으면 한 계획에서도 배분할 구간이 없다.
  delete scene.claims[hidden]!.discrete;
  scene.claims[hidden]!.openDomain=true;
  for (const [value,verdict] of [[0,"ok"],[1,"impossible"],[null,"unknown"]] as const) {
    const result=evaluate(fixed(scene,hidden,value),[plugin]);
    assert.equal(result.goals[0]!.verdict,verdict);
    if (value===null) assert.ok(result.goals[0]!.truncated);
  }
});

// 구간과 행의 존재가 같은 입력을 쓸 때와 서로 다른 입력을 쓸 때를 각각 고정 세계와 대조한다.
const judgingHooks=["negotiate","pools","laneProfiles","match","demand","policy","standingLoads","consume","assess"] as const;
for (const hook of judgingHooks) for (const same of [false,true])
  test("T10 "+hook+(same ? "의 한 주장이 범위와 행의 유무를 정하는 세계" : "가 반환하지 않은 입력을 고정한 세계")+"와 대조한다",()=>{
  const plugin=trialDomain(), {negotiate,demand,consume}=plugin;
  const scene=loadScene("fixtures/three-flows.json",{modelsDir:"fixtures",connectorsFile:"fixtures/connectors.json"},[plugin]);
  scene.workloads.length=scene.members.length=scene.connections.length=hook==="policy" ? 2 : 1;
  const trunk=scene.resources.findIndex(r=>r.id==="trunk");
  const capacity=effectiveClaim(scene,"resource",trunk,plugin.id,"capacity")!;
  const attribute={...scene.claims[capacity]!,ownerKind:"item" as const,owner:scene.resources[trunk]!.item,value:1,openDomain:true as const};
  const omitted=scene.claims.push({...attribute,field:"extraCost"})-1;
  const bounded=same ? omitted : scene.claims.push({...attribute,field:"fixedCost",value:0})-1;
  for (const row of new Set([omitted,bounded])) scene.claimSources.push({...scene.claimSources.find(v=>v.claim===capacity)!,claim:row});
  const extra=(s:Scene)=>Number(readClaim(s,omitted).value)>0;
  const trace={rule:"시험 예산",inputs:[],specs:[]};
  const limit=(s:Scene)=>{
    const cost=readClaim(s,bounded).value as number|null;
    return {inputs:[bounded],limit:cost===null ? null : 50+cost,bounds:{low:50+(cost ?? 0),high:50+(cost ?? 1)}};
  };
  if (hook==="laneProfiles") {
    plugin.laneProfiles=({scene:s})=>[{domain:plugin.id,mode:"pulse",profile:"slow",maxLanes:limit(s).bounds.low,inputs:[bounded]},
      ...(extra(s) ? [{domain:plugin.id,mode:"pulse",profile:"fast",inputs:[]}] : [])];
    plugin.negotiate=l=>negotiate(l).map(o=>({...o,limit:l.laneProfiles?.some(p=>p.profile==="fast") ? 100 : l.laneProfiles?.[0]?.maxLanes ?? 50}));
  } else if (hook==="negotiate") {
    plugin.negotiate=l=>negotiate(l).flatMap(o=>[{...o,...limit(l.scene)},...(extra(l.scene) ? [{...o,limit:100}] : [])]);
  } else if (hook==="pools") {
    plugin.pools=({scene:s})=>{
      const base={...trace,...limit(s),id:"budget",scope:"direction" as const,unit:"회/s"};
      return extra(s) ? [{...base,limit:100},{...base,id:"extra"}] : [base];
    };
    plugin.negotiate=l=>negotiate(l).map(o=>({...o,pool:{id:"budget",domain:plugin.id,perUnit:1}}));
  } else if (hook==="match") {
    plugin.negotiate=l=>negotiate(l).flatMap(o=>[{...o,limit:50},o]);
    plugin.match=({scene:s},o)=>{
      const base=limit(s);
      return {...trace,inputs:base.inputs,verdict:(o.limit!==null && o.limit<=base.bounds.low) || extra(s) ? "ok" : "impossible"};
    };
  } else if (hook==="demand") {
    plugin.demand=(s,w)=>demand(s,w).flatMap(d=>[{...d,preference:1,inputs:[bounded],requested:limit(s).limit},...(extra(s) ? [d] : [])]);
  } else if (hook==="policy") {
    scene.claims[effectiveClaim(scene,"resource",trunk,plugin.id,"policy")!]!.value="port-table";
    plugin.policy=({scene:s,activeWorkloads})=>activeWorkloads.flatMap(workload=>{
      const base={...trace,...limit(s),workload};
      if (workload===0) return [{...base,limit:extra(s) ? 100 : base.limit}];
      return extra(s) ? [base] : [];
    });
  } else if (hook==="standingLoads") {
    plugin.standingLoads=s=>[{...trace,inputs:[bounded],id:"기본",item:0,amount:limit(s).limit,unit:"회/s",targets:[{resource:trunk}]},
      ...(extra(s) ? [{...trace,id:"상시",item:0,amount:850,unit:"회/s",targets:[{resource:trunk}]}] : [])];
  } else if (hook==="consume") {
    plugin.consume=(s,w,steps,d,opts)=>{
      const cost=readClaim(s,bounded).value as number|null;
      return [...consume(s,w,steps,d,opts),{...trace,inputs:[bounded],resource:trunk,coefficient:0,fixed:cost ?? 0,
        ...(cost===null && {fixedHigh:1})},...(extra(s) ? [{...trace,inputs:[omitted],resource:trunk,coefficient:0,fixed:901}] : [])];
    };
  } else {
    plugin.goalMeasures=[{kind:"비용",unit:"회/s",label:"비용"},{kind:"점수",unit:"회/s",label:"점수"}];
    plugin.assess=(s)=>{
      const cost=readClaim(s,bounded).value as number|null;
      return {...trace,inputs:[bounded,omitted],possible:[!same && extra(s) ? "impossible" : "ok"],
        metrics:[{kind:"비용",unit:"회/s",low:cost ?? 0,high:cost ?? 1,inputs:[bounded]},...(extra(s) ? [] : [{kind:"점수",unit:"회/s",low:100,high:100}])]};
    };
  }
  scene.goals=[{id:"작업",kind:"workload",scenario:0,workload:0},
    {id:"포트",kind:"port",scenario:0,workloads:[0],item:scene.nodes[scene.workloads[0]!.from]!.item,port:scene.connections[0]!.from},
    {id:"90",kind:"metric",scenario:0,workloads:[0],run:"together",metric:"delivery",unit:"회/s",minimum:90}];
  if (hook==="assess") scene.goals.push({id:"점수",kind:"metric",scenario:0,workloads:[0],run:"together",metric:"점수",unit:"회/s",minimum:90});
  const run=(s:Scene)=>evaluate(s,[plugin]);
  const zero=run(fixed(scene,omitted,0)),one=run(fixed(scene,omitted,1));
  if (hook==="pools") {
    assert.ok(!zero.linkResources.some(r=>r.pool?.id==="extra"));
    assert.ok(one.linkResources.some(r=>r.pool?.id==="extra"));
  }
  if (hook==="assess" && same) {
    assert.ok(zero.measures.some(m=>m.kind==="점수"));
    assert.ok(!one.measures.some(m=>m.kind==="점수"));
  }
  const differing=zero.goals.filter((g,i)=>g.verdict!==one.goals[i]!.verdict).map(g=>g.id);
  assert.ok(differing.length>0,"입력에 따라 현장에서 목표가 갈려야 한다");
  const pending=run(fixed(fixed(scene,bounded,null),omitted,null));
  for (const id of differing) {
    const goal=pending.goals.findIndex(g=>g.id===id);
    assert.deepEqual([pending.goals[goal]!.verdict,pending.goals[goal]!.truncated],["unknown",true],id);
    assert.ok(pending.goalEvidence.some(e=>e.goal===goal && e.claims.includes(omitted)));
    assert.ok(pending.quests.some(q=>q.claim===omitted));
  }
  if (hook==="consume") {
    for (const [result,rate] of [[zero,100],[one,0],[pending,null]] as const)
      assert.equal(result.allocations.find(a=>a.run==="together")!.value,rate);
  }
  if (hook==="assess") {
    const amounts=run({...fixed(fixed(scene,bounded,null),omitted,null),goals:[]});
    assert.deepEqual(new Set(amounts.rangeInputs.map(r=>r.claim)),new Set([bounded]));
  }
  const finite=fixed(scene,omitted,null);
  finite.claims[omitted]!.discrete=[0,1];
  delete finite.claims[omitted]!.openDomain;
  const expected=zero.goals.map((g,i)=>g.verdict===one.goals[i]!.verdict ? g.verdict : "unknown");
  assert.deepEqual(run(finite).goals.map(g=>[g.verdict,g.truncated]),expected.map(v=>[v,false]));
  if (hook==="assess" || hook==="consume") {
    const covered=run(fixed(scene,bounded,null));
    assert.ok(covered.goals.every(g=>g.verdict==="unknown" && g.truncated));
    assert.ok(covered.quests.some(q=>q.claim===bounded));
  }
  oracle(scene,[plugin],c=>c===scene.claims[omitted]);
});

for (const [field, usb4] of [["cableDataGbps",true],["cableUsb4",true],["cableUsb4",false]] as const)
  test("T4 모델에서 빠진 "+field+"를 "+(usb4 ? "USB4" : "일반 USB")+" 후보의 읽기와 고정 세계로 대조한다",t=>{
    const doc=read("data","scene"), endpoint=read("data","usb-endpoint@1"), cable=read("data","usb-cable@1");
    cable.attributes.data.cableDataGbps.value=40;
    cable.attributes.data.cableUsb4.value=true;
    delete cable.attributes.data[field];
    if (usb4) doc.workloads[0].kind="pcie-tunnel";
    else endpoint.ports[0].interfaces=endpoint.ports[0].interfaces.filter((i:{protocol:string})=>i.protocol==="USB");
    const scene=loadSceneDocuments(doc,{connectors:read("data","connectors"),
      models:new Map([["usb-cable@1",cable],["usb-endpoint@1",endpoint]])},plugins);
    const row=scene.claims.findIndex(c=>c.ownerKind==="item" && c.field===field);
    const claim=scene.claims[row]!;
    assert.equal(claim.value,null);
    assert.ok(scene.claimSources.some(s=>s.claim===row && scene.sources[s.source]!.title==="모델에 값 없음"));
    const values=space(scene,claim,plugins).values;
    assert.deepEqual(new Set(claim.discrete),new Set(values));
    scene.goals=[{kind:"workload",id:"요청 충족",scenario:0,workload:0}];
    const result=evaluate(scene,plugins);
    assert.deepEqual(new Set(result.profileWorlds.filter(w=>w.claim===row).map(w=>w.value)),new Set(usb4 ? values : []));
    assert.equal(result.quests.some(q=>q.claim===row),usb4);
    t.diagnostic(oracle(scene,plugins,c=>c===claim));
  });

test("T7 모델에서 빠진 케이블 길이의 목표를 도달 거리 양쪽의 고정 장면과 대조한다",()=>{
  const doc=read("network","scene");
  doc.items=doc.items.filter((i:{instanceId:string})=>["host-a","router","lan-a-wire"].includes(i.instanceId));
  doc.connections=doc.connections.filter((c:{id:string})=>c.id==="lan-a");
  doc.workloads=doc.workloads.filter((w:{id:string})=>w.id==="first-hop");
  doc.scenarios=[{id:"first-hop",members:["first-hop"],goals:[{kind:"workload",id:"전송",workload:"first-hop"}]}];
  const models=new Map<string,ReturnType<typeof read>>();
  for (const {modelId,revision} of doc.items) {
    const key=modelId+"@"+revision;
    models.set(key,read("network",key));
  }
  const attributes=models.get("network-copper@1").attributes.network;
  const original=attributes.length;
  const run=()=>loadSceneDocuments(doc,{models,connectors:read("network","connectors")},plugins);
  delete attributes.length;
  const scene=run(), row=scene.claims.findIndex(c=>c.domain==="network" && c.field==="length");
  assert.equal(scene.claims[row]!.openDomain,true);
  const result=evaluate(scene,plugins), goal=result.goals[0]!;
  assert.deepEqual([goal.verdict,goal.openClaims],["unknown",[row]]);
  assert.ok(result.quests.some(q=>q.claim===row));
  assert.deepEqual([30,101].map(value=>{
    attributes.length={...original,value};
    return evaluate(run(),plugins).goals[0]!.verdict;
  }),["ok","impossible"]);
});

for (const path of readdirSync("fixtures",{recursive:true,encoding:"utf8"})) {
    if (!path.endsWith(".json")) continue;
    const dir=dirname(path),file=basename(path),doc=read(dir,file.slice(0,-5));
    if (!doc.sceneId || !doc.workloads.some((w:{domain:string})=>plugins.some(p=>p.id===w.domain))) continue;
    const library=dir==="example" ? read(dir,"index").examples.find((e:{scene:string})=>e.scene+".json"===file).fixture : dir;
    test("T10 제품 주장과 고정 세계 "+dir+"/"+file,t=>{
      const connectorsFile=dir==="example" ? "catalog/connectors.json" : "fixtures/"+library+"/connectors.json";
      let scene=loadScene("fixtures/"+dir+"/"+file,{modelsDir:"fixtures/"+library,connectorsFile},plugins);
      t.diagnostic("원본 "+oracle(scene,plugins));
      const other=scene.claims.flatMap((c,row)=>c.value===null ? [{c,row}] : []);
      // 원본의 다른 미확인이 상한을 채워 단일 주장의 차이를 가리는 경우도 검산한다.
      if (other.length) {
        for (const {c,row} of other) {
          const v=space(scene,c,plugins).values[0];
          if (v!==undefined) scene=fixed(scene,row,v);
        }
        t.diagnostic("다른 주장 고정 "+oracle(scene,plugins));
      }
    });
}
