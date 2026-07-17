import assert from "node:assert/strict";
import test from "node:test";

import { resolveAnnouncementDemoAgentRequest } from "../../announcementDemoAgentPlugin.ts";

const baseRequest = {
  provider: null,
  apiKey: null,
  model: null,
  systemPrompt: "You are Fizz.",
  messages: [{ role: "user", content: "Can you help?" }],
};

test("uses OpenAI environment variables when the demo request has no local credentials", () => {
  const request = resolveAnnouncementDemoAgentRequest(baseRequest, {
    OPENAI_API_KEY: "server-openai-key",
    OPENAI_MODEL: "gpt-demo",
  });

  assert.equal(request.provider, "openai");
  assert.equal(request.apiKey, "server-openai-key");
  assert.equal(request.model, "gpt-demo");
});

test("uses Anthropic environment variables with explicit native provider settings", () => {
  const request = resolveAnnouncementDemoAgentRequest(
    { ...baseRequest, provider: "anthropic" },
    {
      ANTHROPIC_API_KEY: "server-anthropic-key",
      ANTHROPIC_MODEL: "claude-demo",
    },
  );

  assert.equal(request.provider, "anthropic");
  assert.equal(request.apiKey, "server-anthropic-key");
  assert.equal(request.model, "claude-demo");
});

test("prefers credentials entered in the app over environment fallbacks", () => {
  const request = resolveAnnouncementDemoAgentRequest(
    {
      ...baseRequest,
      provider: "openai",
      apiKey: "in-app-key",
      model: "in-app-model",
    },
    {
      OPENAI_API_KEY: "server-openai-key",
      OPENAI_MODEL: "server-model",
    },
  );

  assert.equal(request.apiKey, "in-app-key");
  assert.equal(request.model, "in-app-model");
});
