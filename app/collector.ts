// 수집 대본과 원본을 보여 주고 사용자가 확인한 측정 행과 배선만 로컬 장면에 적용한다.
import script from "../collector/collect.ps1?raw";
import { readingNames, type MeasurementPort, type Match, type Preview } from "../collector/capture.ts";

function element<K extends keyof HTMLElementTagNameMap>(tag:K, text="") {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

export function mountCollector(root:HTMLElement, sceneId:()=>string) {
  const open = element("button","수집기");
  open.type = "button";
  open.className = "creator-open";
  root.querySelector(".inventory-heading")!.append(open);
  open.onclick = () => {
    const picker = root.querySelector<HTMLSelectElement>(".scene-title select");
    if (!picker || picker.disabled) {
      root.querySelector(".status")!.textContent = "장면 저장이 끝나면 수집 파일을 열 수 있습니다.";
      return;
    }
    const id = sceneId();
    const dialog = element("dialog");
    dialog.className = "collector";
    dialog.setAttribute("aria-label","Windows 수집기");
    dialog.innerHTML = `
      <style>
        dialog.collector{box-sizing:border-box;width:min(60rem,96vw);max-height:90vh;overflow:auto;padding:24px;color:#193638;background:#fff;border:1px solid #a7bfbb;border-radius:10px;font:14px/1.55 system-ui,sans-serif}
        .collector::backdrop{background:#10272772}.collector header,.collector footer,.collector .file-line{display:flex;align-items:center;gap:12px;justify-content:space-between;flex-wrap:wrap}
        .collector h2,.collector h3{margin:0}.collector p{margin:8px 0}.collector details,.collector footer,.collector .file-line{margin-top:14px}.collector summary{cursor:pointer;font-weight:600}
        .collector pre,.collector code{background:#f0f5f4;padding:8px;display:block;white-space:pre-wrap;overflow-wrap:anywhere}.collector pre{max-height:18rem;overflow:auto}
        .collector button,.collector select,.collector input{font:inherit}.collector button{border:1px solid #b6c9c4;background:#f2f6f5;border-radius:4px;padding:4px 9px;cursor:pointer}
        .collector footer button{background:#215b55;color:white}.collector button:disabled{opacity:.52;cursor:default}.collector [role=status]{color:#335c58}
        .collector .readings{display:grid;gap:7px}.collector article{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);align-items:center;gap:12px;border-bottom:1px solid #dce6e3;padding:7px 0}
        .collector article[hidden]{display:none}.collector article>div{overflow-wrap:anywhere}.collector small{display:block;color:#486360;overflow-wrap:anywhere}.collector select,.collector input[type=text]{max-width:100%;padding:4px;border:1px solid #9cb3ad;border-radius:4px}
        .collector .scope{margin:8px 0;border:1px solid #dae5e1;display:flex;gap:12px;flex-wrap:wrap}.collector label{display:inline-flex;align-items:center;gap:5px}.collector .scope input[type=text]{width:8rem}
        @media(max-width:620px){.collector article{grid-template-columns:1fr}.collector{padding:12px}}
      </style>
      <header><h2>Windows 수집기</h2><button type="button" class="dismiss">닫기</button></header>
      <p>현재 장치의 배선과 협상값을 읽습니다. 장치 목록·부모와 포트 경로, PCIe·USB·NIC 링크, 화면·EDID, 배터리 충방전율이 JSON에 담깁니다.</p>
      <details><summary>실행 방법과 대본 전문</summary>
        <p>대본과 출력 위치를 확인한 뒤, 원하는 경우 저장소 폴더에서 직접 실행하세요.</p>
        <p>수집 결과는 로컬 드라이브의 절대 .json 경로에 씁니다. Add-Type은 C# 컴파일에 시스템 임시 파일과 컴파일러 프로세스를 사용합니다.</p>
        <code>powershell.exe -NoProfile -File .\\collector\\collect.ps1 -Out "$env:TEMP\\benchwire-collect.json"</code>
        <p>Restricted 또는 AllSigned 정책으로 실행이 막히면 장치 관리자와 디스플레이 설정에서 값을 확인하고 퀘스트에 직접 기록하세요.</p><pre></pre>
      </details>
      <div class="file-line"><label>수집 JSON 가져오기 <input type="file" accept=".json,application/json"></label></div>
      <p role="status" aria-live="polite"></p><section class="preview"></section>`;
    dialog.querySelector("pre")!.textContent = script;
    root.append(dialog);
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>(".dismiss")!.onclick = () => dialog.close();
    dialog.onclose = () => dialog.remove();
    const fileInput = dialog.querySelector<HTMLInputElement>("[type=file]")!;
    const status = dialog.querySelector<HTMLElement>("[role=status]")!;
    const area = dialog.querySelector<HTMLElement>(".preview")!;
    async function post(body:unknown,etag?:string) {
      const response = await fetch("/api/collect",{method:"POST",headers:{"Content-Type":"application/json",...(etag && {"If-Match":etag})},
        body:JSON.stringify(body)});
      if (!response.ok) throw new Error((await response.json() as {message:string}).message);
      return response;
    }
    fileInput.onchange = async () => {
      const file = fileInput.files?.[0];
      area.replaceChildren();
      if (!file) return;
      status.textContent = "수집 파일을 확인하고 있습니다.";
      try {
        if (file.size > 16*1024*1024) throw new Error("16 MiB 이하의 JSON 파일을 고르세요.");
        const capture:unknown = JSON.parse((await file.text()).replace(/^\uFEFF/,""));
        const preview = await (await post({sceneId:id,capture})).json() as Preview;
        if (!dialog.isConnected || file !== fileInput.files?.[0]) return;
        status.textContent = `${preview.capture.capturedAt} · Windows ${preview.capture.osBuild} · 장치 ${preview.capture.devices.length}개 · 측정 ${preview.rows.length}행`;
        render(preview);
      } catch (error) {
        if (file === fileInput.files?.[0]) status.textContent = error instanceof Error ? error.message : String(error);
      }
    };

    function render(preview:Preview) {
      const {capture} = preview;
      const devices = new Map(capture.devices.map(d => [d.id,d]));
      const tree = element("details");
      tree.append(element("summary","원본 장치와 경로"));
      for (const d of capture.devices) {
        const line = element("p",d.name+" · "+d.id);
        line.append(element("small",["부모 "+(d.parent ?? "미확인"),"자식 "+(d.children.join(", ") || "없음"),...d.locations,...d.hardwareIds,
          "드라이버 "+(d.driver ?? "미확인")].join(" · ")));
        tree.append(line);
      }
      const heading = element("h3","실물·포트 맞추기");
      const filter = element("input");
      filter.type = "search";
      filter.placeholder = "이름, VID/PID, 부모, 포트 경로";
      filter.setAttribute("aria-label","수집 장치 찾기");
      const fileLine = element("div");
      fileLine.className = "file-line";
      fileLine.append(heading,filter);
      const readings = element("div");
      readings.className = "readings";
      const scopes = element("div");
      const foot = element("footer");
      const acknowledged = element("input");
      acknowledged.type = "checkbox";
      const label = element("label");
      label.append(acknowledged,"수집 당시의 배선·실물·펌웨어·조건과 일치합니다.");
      const apply = element("button","확인한 측정 적용");
      foot.append(label,apply);
      area.append(tree,fileLine,readings,scopes,foot);
      const picks = new Map<number,Match>();
      const fields = new Map<string, {instanceId:string;firmware?:string|null;measurementCondition?:string|null}>();
      const filters:{element:HTMLElement;text:string}[] = [];
      for (const {row,candidates} of preview.rows) {
        const r = capture.readings[row]!;
        const d = r.device ? devices.get(r.device) : undefined;
        const entry = element("article");
        const value = r.value === null ? "미수집 · "+r.reason : String(r.value)+(r.unit ? " "+r.unit : "");
        const title = element("div");
        title.append(element("strong",readingNames[r.kind]+" · "+value),element("small",d ? [d.name,d.id,d.parent,...d.locations,...d.hardwareIds].filter(Boolean).join(" · ") : "시스템"));
        if (r.kind === "usbParent" || r.kind === "outputGpu") {
          if (candidates.length) title.append(element("small","측정된 부모 또는 GPU가 직접 붙은 포트와 내부 노드를 고르세요."));
        }
        entry.append(title);
        if (candidates.length) {
          const select = element("select");
          select.setAttribute("aria-label",readingNames[r.kind]+" "+(d?.id ?? ""));
          select.add(new Option("실물과 포트를 선택하세요",""));
          for (const c of candidates) select.add(new Option(c.label,c.key));
          const saved = candidates.filter(c => c.applied);
          if (saved.length === 1) {
            select.value = saved[0]!.key;
            select.disabled = true;
            title.append(element("small","이 배선에서 이미 확인한 맞춤"));
          }
          select.onchange = () => {
            const match = candidates.find(c => c.key === select.value);
            if (match) picks.set(row,match);
            else picks.delete(row);
            acknowledged.checked = false;
            renderScopes();
          };
          entry.append(select);
        } else entry.append(element("small",r.value === null ? "수집하지 못한 이유를 원본에 보관" : "측정 원본에 보관"));
        readings.append(entry);
        filters.push({element:entry,text:(title.textContent ?? "").toLocaleLowerCase()});
      }
      filter.oninput = () => {
        for (const entry of filters) entry.element.hidden = !entry.text.includes(filter.value.toLocaleLowerCase().trim());
      };
      const selectedItems = () => new Map([...picks.values()].flatMap(m => m.ports.map(p => [p.instanceId,p] as const)));
      function update() {
        const complete = [...selectedItems().keys()].every(k => {
          const f = fields.get(k);
          return f?.firmware !== undefined && f.measurementCondition !== undefined;
        });
        apply.disabled = !picks.size || !complete || !acknowledged.checked;
      }
      function renderScopes() {
        scopes.replaceChildren();
        for (const p of selectedItems().values()) {
          let values = fields.get(p.instanceId);
          if (!values) {
            values = {instanceId:p.instanceId};
            if (p.firmware !== undefined) values.firmware = p.firmware;
            if (p.measurementCondition !== undefined) values.measurementCondition = p.measurementCondition;
            fields.set(p.instanceId,values);
          }
          const group = element("fieldset");
          group.className = "scope";
          group.append(element("legend",p.instanceId));
          for (const [key,title] of [["firmware","펌웨어"],["measurementCondition","측정 조건"]] as const) {
            group.append(contextField(p,key,title));
          }
          scopes.append(group);
        }
        update();
      }
      function contextField(p:MeasurementPort,key:"firmware"|"measurementCondition",title:string) {
        const stored = fields.get(p.instanceId)!;
        const label = element("span",title+" ");
        if (p[key] !== undefined) { label.append(element("strong",p[key] ?? "해당 없음")); return label; }
        const input = element("input");
        input.type = "text";
        input.setAttribute("aria-label",p.instanceId+" "+title);
        const absent = element("input");
        absent.type = "checkbox";
        absent.setAttribute("aria-label",p.instanceId+" "+title+" 해당 없음");
        absent.checked = stored[key] === null;
        input.disabled = absent.checked;
        input.value = stored[key] ?? "";
        function edit() {
          input.disabled = absent.checked;
          if (absent.checked) stored[key] = null;
          else if (input.value.trim()) stored[key] = input.value.trim();
          else delete stored[key];
          acknowledged.checked = false;
          update();
        }
        input.oninput = absent.onchange = edit;
        const absentLabel = element("label");
        absentLabel.append(absent,"해당 없음");
        label.append(input," ",absentLabel);
        return label;
      }
      acknowledged.onchange = update;
      update();
      apply.onclick = async () => {
        if (picker?.disabled || !acknowledged.checked) return;
        apply.disabled = fileInput.disabled = true;
        const dismiss = dialog.querySelector<HTMLButtonElement>(".dismiss")!;
        dismiss.disabled = true;
        dialog.oncancel = event => event.preventDefault();
        try {
          const response = await post({sceneId:id,captureId:preview.captureId,picks:[...picks].map(([row,m]) => ({row,key:m.key})),
            contexts:[...selectedItems().keys()].map(k => fields.get(k))},preview.etag);
          const saved = await response.json() as {id:string};
          dialog.close();
          if (picker && root.contains(picker)) {
            if (![...picker.options].some(o => o.value === saved.id)) picker.add(new Option(saved.id,saved.id));
            picker.value = saved.id;
            picker.dispatchEvent(new Event("change"));
          }
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : String(error);
          status.scrollIntoView({block:"nearest"});
        } finally { fileInput.disabled = dismiss.disabled = false; dialog.oncancel = null; update(); }
      };
    }
  };
}
