import { Effect, Schema } from "effect"
import { createLocalProviderPlugin } from "./local.js"

const RemoteModel = Schema.Struct({
  type: Schema.Literals(["llm", "embedding"]),
  key: Schema.String,
  display_name: Schema.String,
  architecture: Schema.NullOr(Schema.String).pipe(Schema.optional),
  loaded_instances: Schema.Array(
    Schema.Struct({
      config: Schema.Struct({ context_length: Schema.Int }),
    }),
  ),
  max_context_length: Schema.Int,
  capabilities: Schema.Struct({
    vision: Schema.Boolean,
    trained_for_tool_use: Schema.Boolean,
  }).pipe(Schema.optional),
})

const Response = Schema.Struct({ models: Schema.Array(RemoteModel) })

const LegacyV0Model = Schema.Struct({
  id: Schema.String,
  type: Schema.String.pipe(Schema.optional),
  arch: Schema.NullOr(Schema.String).pipe(Schema.optional),
  state: Schema.String.pipe(Schema.optional),
  max_context_length: Schema.Int.pipe(Schema.optional),
  loaded_context_length: Schema.Int.pipe(Schema.optional),
  capabilities: Schema.Array(Schema.String).pipe(Schema.optional),
})

const LegacyV0Response = Schema.Struct({ data: Schema.Array(LegacyV0Model) })

const OpenAIModel = Schema.Struct({
  id: Schema.String,
})

const OpenAIResponse = Schema.Struct({ data: Schema.Array(OpenAIModel) })

export const make = createLocalProviderPlugin({
  id: "opencode.provider.lmstudio",
  providerID: "lmstudio",
  name: "LM Studio",
  origin: "http://127.0.0.1:1234",
  stripPathSuffix: /\/(?:api\/)?v1$/,
  discover: (client) =>
    Effect.gen(function* () {
      const v1 = yield* client.getJson("/api/v1/models", Response).pipe(Effect.orElseSucceed(() => undefined))
      if (v1) {
        return v1.models
          .filter((model) => model.type === "llm" && model.key.length > 0)
          .toSorted((a, b) => a.key.localeCompare(b.key))
      }
      const v0 = yield* client.getJson("/api/v0/models", LegacyV0Response).pipe(Effect.orElseSucceed(() => undefined))
      if (v0) {
        return v0.data
          .filter((model) => model.type !== "embeddings" && model.type !== "embedding" && model.id.length > 0)
          .map((model) => ({
            type: "llm" as const,
            key: model.id,
            display_name: model.id,
            architecture: model.arch ?? null,
            loaded_instances:
              model.loaded_context_length && model.loaded_context_length > 0
                ? [{ config: { context_length: model.loaded_context_length } }]
                : [],
            max_context_length: model.max_context_length ?? 32_768,
            capabilities: {
              vision:
                model.type === "vlm" ||
                Boolean(model.capabilities?.includes("vision")) ||
                /vl|vision|llava|pixtral|gemma-3|gemma-4/i.test(model.id),
              trained_for_tool_use:
                Boolean(model.capabilities?.includes("tool_use")) ||
                /qwen|llama-3\.[123]|mistral|deepseek|claude|gpt|gemma-4|command-r|hermes/i.test(model.id),
            },
          }))
          .toSorted((a, b) => a.key.localeCompare(b.key))
      }
      const openai = yield* client.getJson("/v1/models", OpenAIResponse)
      return openai.data
        .filter((model) => model.id.length > 0 && !/embed|nomic|bge-/i.test(model.id))
        .map((model) => ({
          type: "llm" as const,
          key: model.id,
          display_name: model.id,
          architecture: null,
          loaded_instances: [],
          max_context_length: 32_768,
          capabilities: {
            vision: /vl|vision|llava|pixtral|gemma-3|gemma-4/i.test(model.id),
            trained_for_tool_use:
              /qwen|llama-3\.[123]|mistral|deepseek|claude|gpt|gemma-4|command-r|hermes/i.test(model.id),
          },
        }))
        .toSorted((a, b) => a.key.localeCompare(b.key))
    }),
  model: (item) => ({
    id: item.key,
    name: item.display_name || item.key,
    family: item.architecture,
    tools: item.capabilities?.trained_for_tool_use,
    vision: item.capabilities?.vision,
    context:
      item.loaded_instances.length === 0
        ? item.max_context_length
        : Math.min(...item.loaded_instances.map((instance) => instance.config.context_length)),
  }),
})

export const LMStudioPlugin = make()
