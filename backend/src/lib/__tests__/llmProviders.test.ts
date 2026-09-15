import { describe, expect, it } from "vitest";
import {
  fallbackReasoningLevelFromProviderError,
  withThinkingDisabled,
} from "../llm/providers";

describe("fallbackReasoningLevelFromProviderError", () => {
  it("selects the nearest level advertised by a provider", () => {
    const error = new Error(
      "Unsupported value: 'low' is not supported with the model. Supported values are: 'none', 'medium', 'high', and 'xhigh'.",
    );

    expect(fallbackReasoningLevelFromProviderError(error, "low")).toBe(
      "medium",
    );
  });

  it("does not retry unrelated provider failures", () => {
    expect(
      fallbackReasoningLevelFromProviderError(
        new Error("The provider is unavailable"),
        "high",
      ),
    ).toBeUndefined();
  });
});

describe("withThinkingDisabled", () => {
  it("adds vLLM's enable_thinking=false to a JSON chat completion body", async () => {
    let sent: RequestInit | undefined;
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent = init;
      return new Response("{}");
    };
    await withThinkingDisabled(fetchImpl)("http://gateway/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "qwen", messages: [], max_tokens: 64 }),
    });
    expect(JSON.parse(sent?.body as string)).toEqual({
      model: "qwen",
      messages: [],
      max_tokens: 64,
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  it("passes non-JSON requests through untouched", async () => {
    let sent: RequestInit | undefined;
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent = init;
      return new Response("{}");
    };
    await withThinkingDisabled(fetchImpl)("http://gateway/v1/models", { method: "GET" });
    expect(sent).toEqual({ method: "GET" });
  });
});
