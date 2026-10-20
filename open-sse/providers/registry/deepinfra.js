export default {
  id: "deepinfra",
  priority: 75,
  alias: "deepinfra",
  aliases: [
    "di",
  ],
  uiAlias: "di",
  display: {
    name: "DeepInfra",
    icon: "memory",
    color: "#4C5FF7",
    textIcon: "DI",
    website: "https://deepinfra.com",
    notice: {
      apiKeyUrl: "https://deepinfra.com/dash/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  transport: {
    baseUrl: "https://api.deepinfra.com/v1/openai/chat/completions",
    validateUrl: "https://api.deepinfra.com/v1/openai/models",
  },
  // Flex service tier: opt in per request with the OpenAI-standard
  // `"service_tier": "flex"` body field — 0.8× token price for best-effort
  // scheduling (waits up to 10 min under load, then HTTP 429, unbilled).
  // No router toggle needed: openai→openai requests skip translation and no
  // strip rule drops service_tier, so the field reaches DeepInfra verbatim.
  // Models without the tier serve at standard price and echo
  // `service_tier: "default"` back in the response.
  // The live catalogue is public — /models answers 200 without a key and 401
  // with a bad one, so validateUrl doubles as the key probe.
  models: [
    { id: "deepseek-ai/DeepSeek-V4-Pro", name: "DeepSeek V4 Pro" },
    { id: "deepseek-ai/DeepSeek-V4.1-Flash", name: "DeepSeek V4.1 Flash" },
    { id: "deepseek-ai/DeepSeek-V3.2", name: "DeepSeek V3.2" },
    { id: "moonshotai/Kimi-K3", name: "Kimi K3" },
    { id: "moonshotai/Kimi-K2.6", name: "Kimi K2.6" },
    { id: "zai-org/GLM-5.3-Flash", name: "GLM 5.3 Flash" },
    { id: "zai-org/GLM-4.7", name: "GLM 4.7" },
    { id: "Qwen/Qwen3.5-397B-A17B", name: "Qwen3.5 397B A17B" },
    { id: "Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo", name: "Qwen3 Coder 480B Turbo" },
    { id: "Qwen/Qwen3-Next-80B-A3B-Instruct", name: "Qwen3 Next 80B" },
    { id: "MiniMaxAI/MiniMax-M3", name: "MiniMax M3" },
    { id: "ByteDance/Seed-2.0-code", name: "Seed 2.0 Code" },
    { id: "openai/gpt-oss-20b", name: "GPT-OSS 20B" },
    { id: "meta-llama/Llama-4-Scout-17B-16E-Instruct", name: "Llama 4 Scout 17B" },
  ],
  modelsFetcher: { url: "https://api.deepinfra.com/v1/openai/models", type: "deepinfra" },
  passthroughModels: true,
};
