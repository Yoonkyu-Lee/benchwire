// 사용자 설정의 알려진 값을 검증하고 바꿀 항목만 settings.json에 함께 저장한다.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { productRef } from "../scene/files.ts";
import { LibraryError, writeAtomic } from "./library.ts";

export const preferredSellers = z.array(productRef.shape.seller)
  .refine(values => new Set(values).size === values.length, "판매처가 중복됩니다");
const settingsFile = z.looseObject({ preferredSellers: preferredSellers.default([]), helpDismissed: z.boolean().default(false) });
const dismissal = z.strictObject({ helpDismissed: z.literal(true) });

export function openSettings(dir: string) {
  const path = join(dir, "settings.json");
  function read() {
    let text: string;
    try { text = readFileSync(path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return settingsFile.parse({});
      throw error;
    }
    return settingsFile.parse(JSON.parse(text));
  }
  function write(settings: z.output<typeof settingsFile>) {
    writeAtomic(path, JSON.stringify(settings, null, 2) + "\n");
  }
  return {
    read,
    prefer(sellers: string[]) {
      write({ ...read(), preferredSellers: sellers });
    },
    dismissHelp(body: unknown) {
      if (!dismissal.safeParse(body).success) throw new LibraryError(422, "helpDismissed", "도움말 닫기 값이 필요합니다");
      const settings = read();
      if (!settings.helpDismissed) write({ ...settings, helpDismissed: true });
    },
  };
}
