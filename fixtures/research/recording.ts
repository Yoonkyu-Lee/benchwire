// 가상 충전기의 조사 응답을 SDK 경계에서 순서대로 재생한다.
import type Anthropic from "@anthropic-ai/sdk";
import type { ResearchClient } from "../../server/research.ts";
import fixture from "./finch.json" with { type: "json" };

export const recording = fixture as unknown as Record<keyof typeof fixture, Anthropic.Message>;

export function fixtureClient(messages: readonly Anthropic.Message[]) {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: ResearchClient = {
    stream(params) {
      const message = messages[calls.length];
      calls.push(structuredClone(params));
      return { async finalMessage() {
        if (!message) throw new Error("가상 응답이 없습니다.");
        return structuredClone(message);
      } };
    },
  };
  return { calls, client };
}
