// 서버 키로 Claude 클라이언트를 구성하고 호출 전 상한과 응답 사용량을 같은 요율로 계산한다.
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

export const CLAUDE_MODEL = "claude-opus-5-5";
// https://platform.claude.com/docs/en/about-claude/pricing
const INPUT_USD = 4 / 1_000_000, OUTPUT_USD = 20 / 1_000_000, CACHE_READ_USD = 0.20 / 1_000_000;
const SEARCH_USD = 10 / 1_000;
export type ResearchClient = {
  stream(params: Anthropic.MessageCreateParamsNonStreaming): { finalMessage(): Promise<Anthropic.Message> };
};
export function optionalText(file: string) {
  try { return readFileSync(file,"utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}
export function serverKey(root: string, name: string) {
  return (process.env[name] ?? parseEnv(optionalText(join(root,".env")) ?? "")[name])?.trim() || null;
}
export function configuredResearchClient(root: string): ResearchClient | null {
  const apiKey = serverKey(root,"ANTHROPIC_API_KEY");
  return apiKey ? new Anthropic({apiKey,baseURL:"https://api.anthropic.com",maxRetries:0,logLevel:"off"}).messages : null;
}
export function claudeCost(input: number, output: number, searches = 0) {
  return input * INPUT_USD + output * OUTPUT_USD + searches * SEARCH_USD;
}
export function usageCost(usage: Anthropic.Usage) {
  return claudeCost(usage.input_tokens,usage.output_tokens,usage.server_tool_use?.web_search_requests ?? 0)
    + (usage.cache_creation?.ephemeral_5m_input_tokens ?? 0) * INPUT_USD * 1.25
    + (usage.cache_creation?.ephemeral_1h_input_tokens ?? 0) * INPUT_USD * 2
    + (usage.cache_read_input_tokens ?? 0) * CACHE_READ_USD;
}
