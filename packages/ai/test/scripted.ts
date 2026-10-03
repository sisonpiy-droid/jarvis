import type { GenerateRequest, Message, ModelProvider, Part } from "../src/model";

// Test helpers: a scripted model that returns queued replies in order and records every request,
// and shorthands for neutral messages.

export function scripted(...replies: Message[]) {
  const requests: GenerateRequest[] = [];
  const model: ModelProvider = {
    name: "scripted",
    async generate(req) {
      requests.push(structuredClone(req));
      const r = replies.shift();
      if (!r) throw new Error("no more scripted replies");
      return r;
    },
  };
  return { model, requests };
}

export const say = (text: string): Message => ({ role: "assistant", parts: [{ type: "text", text }] });
export const text = (t: string): Part => ({ type: "text", text: t });
export const call = (name: string, args: Record<string, unknown> = {}, id = `gx-test-${name}`): Part => ({ type: "tool_call", id, name, args });
export const calls = (...parts: Part[]): Message => ({ role: "assistant", parts });
