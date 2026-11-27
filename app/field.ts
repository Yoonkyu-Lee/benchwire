// 스키마의 한 필드를 표시하고 미선언·미확인·명시값을 구별해 읽는다.
import { z } from "zod";
import type { InputSchema } from "../engine/contract.ts";

export type JSONSchema = z.core.JSONSchema.JSONSchema;
type Value = string | number | boolean | null;
export type FieldValue = { value: Value; unit: string };

export function describe(schema: InputSchema): JSONSchema {
  if (!(schema instanceof z.ZodType)) throw new Error("폼의 입력 스키마가 필요합니다.");
  return z.toJSONSchema(schema, { io: "input" });
}

let fieldId = 0;
export function field(container: HTMLElement, label: string, control: HTMLInputElement | HTMLSelectElement, path = "") {
  const row = document.createElement("div");
  row.className = "scenario-field";
  control.id = "field-" + ++fieldId;
  if (label) {
    const name = document.createElement("label");
    name.textContent = label;
    name.htmlFor = control.id;
    row.append(name);
  }
  row.append(control);
  if (path) {
    const error = document.createElement("span");
    error.id = control.id + "-error";
    error.className = "scenario-error";
    error.dataset.path = path;
    error.setAttribute("role", "alert");
    control.setAttribute("aria-describedby", error.id);
    row.append(error);
  }
  container.append(row);
  return row;
}

export function showError(form: HTMLFormElement, message: string) {
  const marker = message.indexOf(" — ");
  const path = marker < 0 ? "" : message.slice(0, marker).split("#").at(-1)!;
  const errors = [...form.querySelectorAll<HTMLElement>(".scenario-error")];
  const nearest = errors.filter(error => {
    const key = error.dataset.path;
    return key && (path === key || path.startsWith(key + "."));
  }).sort((a, b) => b.dataset.path!.length - a.dataset.path!.length)[0];
  (nearest ?? errors.at(-1)!).textContent = marker < 0 ? message : message.slice(marker + 3);
}

function alternatives(schema: JSONSchema): JSONSchema[] {
  if (schema.anyOf) return schema.anyOf.flatMap(alternatives);
  return Array.isArray(schema.type) ? schema.type.map(type => ({ ...schema, type })) : [schema];
}

export function fieldUnit(schema: JSONSchema) {
  const unit = schema.properties?.unit;
  const literal = typeof unit === "object" ? unit.const : undefined;
  return typeof literal === "string" ? literal : "";
}

export function claimInput(form: HTMLElement, key: string, property: JSONSchema | boolean, required: boolean,
  initial: { value: Value; unit?: string | undefined } | undefined, path: string) {
  if (typeof property !== "object" || typeof property.properties?.value !== "object")
    throw new Error("주장 필드의 값 스키마가 필요합니다: " + key);
  const variants = alternatives(property.properties.value);
  const canBeUnknown = variants.some(schema => schema.type === "null");
  const known = variants.filter(schema => schema.type !== "null");
  const unit = fieldUnit(property) || initial?.unit || "";
  const options = known.map(schema => schema.enum ?? (schema.const !== undefined ? [schema.const] : schema.type === "boolean" ? [true, false] : undefined));
  const choices = options.every(choice => choice !== undefined) ? options.flatMap(choice => choice!) : undefined;
  let read: () => Value;
  let control: HTMLSelectElement | HTMLInputElement;
  if (choices?.length) {
    const select = document.createElement("select");
    select.append(...choices.map(choice => new Option(choice === true ? "예" : choice === false ? "아니요" : String(choice))));
    select.selectedIndex = Math.max(0, choices.indexOf(initial?.value ?? null));
    control = select;
    read = () => choices[select.selectedIndex]!;
  } else {
    const input = document.createElement("input");
    const numeric = known.every(schema => schema.type === "number" || schema.type === "integer" || typeof schema.const === "number");
    input.type = numeric ? "number" : "text";
    if (numeric) input.step = known.every(schema => schema.type === "integer") ? "1" : "any";
    input.value = initial?.value == null ? "" : String(initial.value);
    control = input;
    read = () => numeric ? input.valueAsNumber : input.value;
  }
  const label = property.title ?? key;
  const caption = unit ? `${label} (${unit})` : label;
  const row = field(form, caption, control, path);
  const mode = document.createElement("select");
  mode.setAttribute("aria-label", caption + " 상태");
  mode.append(new Option("값 지정", "value"));
  if (canBeUnknown) mode.append(new Option("미확인", "unknown"));
  if (!required) mode.append(new Option("미지정", "omit"));
  mode.value = initial === undefined && !required ? "omit" : canBeUnknown && initial?.value === null ? "unknown" : "value";
  control.disabled = mode.value !== "value";
  mode.addEventListener("change", () => { control.disabled = mode.value !== "value"; });
  if (canBeUnknown || !required) {
    row.classList.add("scenario-request");
    row.insertBefore(mode, row.querySelector(".scenario-error"));
  }
  return { row, read: (): FieldValue | undefined => mode.value === "omit" ? undefined
    : { value: mode.value === "unknown" ? null : read(), unit } };
}
