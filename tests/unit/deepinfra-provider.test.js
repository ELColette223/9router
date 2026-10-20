import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS } from "../../open-sse/providers/index.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { resolveProviderAlias } from "../../open-sse/services/model.js";
import { PROVIDER_MODELS, isValidModel, getModelUpstreamId } from "../../open-sse/config/providerModels.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { stripUnsupportedParams } from "../../open-sse/translator/concerns/paramSupport.js";
import { FILTERS } from "../../src/app/api/providers/suggested-models/filters.js";

const entry = REGISTRY.find((e) => e.id === "deepinfra");

describe("deepinfra provider", () => {
  it("is registered as a paid OpenAI-compatible apikey provider", () => {
    expect(entry).toBeDefined();
    expect(entry.category).toBe("apikey");
    expect(entry.authType).toBe("apikey");
    expect(PROVIDERS.deepinfra.baseUrl).toBe("https://api.deepinfra.com/v1/openai/chat/completions");
    expect(PROVIDERS.deepinfra.format).toBe("openai");
  });

  it("resolves its aliases and exposes UI display fields", () => {
    expect(resolveProviderAlias("di")).toBe("deepinfra");
    expect(resolveProviderAlias("deepinfra")).toBe("deepinfra");
    expect(entry.display.name).toBe("DeepInfra");
    expect(entry.display.textIcon).toBeTruthy();
    expect(entry.display.notice.apiKeyUrl).toBe("https://deepinfra.com/dash/keys");
  });

  it("routes through the shared DefaultExecutor", () => {
    expect(getExecutor("deepinfra")).toBeInstanceOf(DefaultExecutor);
  });

  it("accepts catalog ids from the static list and arbitrary ids via passthrough", () => {
    expect(entry.passthroughModels).toBe(true);
    expect(isValidModel("deepinfra", "deepseek-ai/DeepSeek-V4-Pro")).toBe(true);
    // Request-time passthrough: unknown catalogue ids are forwarded untouched.
    expect(getModelUpstreamId("deepinfra", "some-new/release-model")).toBe("some-new/release-model");
    expect(PROVIDER_MODELS.deepinfra.length).toBeGreaterThan(0);
  });

  it("declares modelsFetcher pointing at the public catalogue with a filter", () => {
    expect(entry.modelsFetcher).toEqual({
      url: "https://api.deepinfra.com/v1/openai/models",
      type: "deepinfra",
    });
    expect(typeof FILTERS.deepinfra).toBe("function");
  });
});

describe("deepinfra model discovery", () => {
  const MODELS_ROUTE = join(
    dirname(fileURLToPath(import.meta.url)), "..", "..",
    "src", "app", "api", "providers", "[id]", "models", "route.js"
  );
  const source = readFileSync(MODELS_ROUTE, "utf8");

  it("registers deepinfra in the /models resolver at its own /models URL", () => {
    const line = source.split("\n").find((l) => l.trim().startsWith("deepinfra: createOpenAIModelsConfig("));
    expect(line, "no models entry for deepinfra").toBeTruthy();
    expect(line).toContain("https://api.deepinfra.com/v1/openai/models");
  });

  it("validates api keys against the models endpoint in testUtils", () => {
    const testUtils = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "..",
        "src", "app", "api", "providers", "[id]", "test", "testUtils.js"),
      "utf8"
    );
    expect(testUtils).toContain('case "deepinfra":');
  });

  it("keeps only chat-capable ids and maps catalogue metadata", () => {
    const rows = FILTERS.deepinfra([
      {
        id: "deepseek-ai/DeepSeek-V3.2",
        metadata: { tags: ["chat", "prompt_cache"], context_length: 163840 },
      },
      {
        id: "Qwen/Qwen3-Embedding-8B",
        metadata: { tags: ["embedding"], context_length: 32768 },
      },
      { id: "no-tags-model" },
    ]);
    expect(rows).toEqual([
      { id: "deepseek-ai/DeepSeek-V3.2", name: "DeepSeek-V3.2", contextLength: 163840 },
    ]);
    expect(FILTERS.deepinfra([])).toEqual([]);
    expect(FILTERS.deepinfra("garbage")).toEqual([]);
  });
});

describe("deepinfra flex service tier", () => {
  const body = () => ({
    model: "deepseek-ai/DeepSeek-V3.2",
    messages: [{ role: "user", content: "hi" }],
    service_tier: "flex",
  });

  it("keeps service_tier through the DefaultExecutor request transform", () => {
    const transformed = new DefaultExecutor("deepinfra").transformRequest(
      "deepseek-ai/DeepSeek-V3.2", body(), true, {}
    );
    expect(transformed.service_tier).toBe("flex");
  });

  it("keeps service_tier through stripUnsupportedParams", () => {
    const stripped = stripUnsupportedParams("deepinfra", "deepseek-ai/DeepSeek-V3.2", body());
    expect(stripped.service_tier).toBe("flex");
  });

  it("keeps service_tier on the openai→openai translation path", () => {
    const result = translateRequest("openai", "openai", "deepseek-ai/DeepSeek-V3.2", body(), true);
    expect(result.service_tier).toBe("flex");
  });

  it("does not add service_tier when the client did not send one", () => {
    const transformed = new DefaultExecutor("deepinfra").transformRequest(
      "deepseek-ai/DeepSeek-V3.2",
      { model: "deepseek-ai/DeepSeek-V3.2", messages: [{ role: "user", content: "hi" }] },
      true,
      {}
    );
    expect(transformed.service_tier).toBeUndefined();
  });
});
