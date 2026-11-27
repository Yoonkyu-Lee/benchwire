// 로컬 API의 장면을 작업대에 열고 확정 편집을 ETag 순서대로 저장한다.
import "./style.css";
import type { z } from "zod";
import type { connectorsFile } from "../scene/files.ts";
import type { CanvasLibrary } from "./canvas.ts";
import type { SceneDocument } from "./document.ts";
import { mountWorkbench } from "./workbench.ts";

interface LibraryResponse extends CanvasLibrary {
  defaultSceneId: string;
  scenes: { id: string; title: string; example: boolean }[];
  connectors: z.output<typeof connectorsFile>;
}

const root = document.querySelector<HTMLElement>("#app")!;
const notice = document.querySelector<HTMLElement>("#storage-status")!;
const message = notice.querySelector("span")!;
const reopen = notice.querySelector("button")!;
const picker = document.createElement("select");
picker.setAttribute("aria-label", "장면");

function status(text = "", canReopen = false) {
  message.textContent = text;
  reopen.hidden = !canReopen;
  notice.hidden = text === "";
}

async function fetchLocal(url: string, init?: RequestInit) {
  try { return await fetch(url, init); }
  catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
}

async function start() {
  const response = await fetchLocal("/api/library");
  if (!response?.ok) {
    status("라이브러리를 열 수 없습니다.");
    return;
  }
  const library = await response.json() as LibraryResponse;
  for (const { id, title } of library.scenes) picker.add(new Option(title, id));

  let saved: SceneDocument;
  let etag: string;
  let workbench: ReturnType<typeof mountWorkbench>;
  let saving = false;
  let mustReopen = false;
  const edits: SceneDocument[] = [];

  async function open(id: string) {
    root.inert = true;
    reopen.disabled = true;
    try {
      const result = await fetchLocal("/api/scenes/" + encodeURIComponent(id));
      const tag = result?.headers.get("ETag");
      if (!result?.ok || !tag) {
        if (saved) picker.value = saved.sceneId;
        status("장면을 열 수 없습니다.", Boolean(saved));
        return;
      }
      const scene = await result.json() as SceneDocument;
      workbench = mountWorkbench(root, scene, library, { onChange: edited });
      saved = scene;
      etag = tag;
      mustReopen = false;
      picker.value = id;
      root.querySelector(".scene-title h1")!.replaceWith(picker);
      root.querySelector(".stage")!.append(notice);
      status();
    } finally {
      root.inert = false;
      reopen.disabled = false;
    }
  }

  function edited(scene: SceneDocument) {
    if (mustReopen) { workbench.replaceDocument(saved); return; }
    edits.push(scene);
    if (!saving) void save();
  }

  function rejectEdit(text: string, reload: boolean) {
    edits.length = 0;
    mustReopen = reload;
    workbench.replaceDocument(saved);
    status(text, reload);
  }

  async function save() {
    saving = true;
    picker.disabled = true;
    status("저장 중…");
    try {
      for (let edit = edits.shift(); edit; edit = edits.shift()) {
        const document = { ...edit, sceneId: saved.sceneId };
        const result = await fetchLocal("/api/scenes/" + encodeURIComponent(document.sceneId), {
          method: "PUT", headers: { "Content-Type": "application/json", "If-Match": etag }, body: JSON.stringify(document),
        });
        if (!result) {
          rejectEdit("저장 결과를 확인할 수 없습니다. 장면을 다시 열어 주세요.", true);
          return;
        }
        if (result.status === 412) {
          rejectEdit("다른 곳에서 장면을 저장했습니다. 다시 열어 주세요.", true);
          return;
        }
        if (result.status === 422) {
          const error = await result.json() as { path: string; message: string };
          rejectEdit(error.path ? `${error.path} — ${error.message}` : error.message, false);
          return;
        }
        const tag = result.headers.get("ETag");
        if (!tag || (result.status !== 201 && result.status !== 204)) {
          rejectEdit("장면을 저장하지 못했습니다. 다시 열어 주세요.", true);
          return;
        }
        if (result.status === 201) {
          saved = await result.json() as SceneDocument;
          picker.add(new Option(saved.sceneId, saved.sceneId));
          picker.value = saved.sceneId;
        } else saved = document;
        etag = tag;
      }
      status("저장됨");
    } finally {
      saving = false;
      picker.disabled = false;
    }
  }

  picker.addEventListener("change", () => { void open(picker.value); });
  reopen.addEventListener("click", () => { void open(saved.sceneId); });
  await open(library.defaultSceneId);
}

void start();
