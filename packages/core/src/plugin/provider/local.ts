import { define } from "@opencode/plugin/effect/plugin"
import type { Document, Entry } from "@opencode/schema/config"
import { Duration, Effect, Option, Schedule, type Schema, Semaphore, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { shellParserWasm } from "#shell-parser-wasm"
import { Config } from "../../config.js"
import { Environment } from "../../environment/index.js"
import { EnvironmentUnavailable } from "../../environment/unavailable.js"
import { Location } from "../../location.js"
import { Model } from "../../model.js"
import type { PluginInternal } from "../internal.js"
import { foldSettings } from "./configured.js"

export type LocalModel = {
  readonly id: string
  readonly name?: string
  readonly family?: string | null
  readonly tools?: boolean
  readonly vision?: boolean
  readonly context?: number | null
}

export type LocalDiscoveryClient = ReturnType<typeof createClient>

type ConfiguredSource = ReturnType<typeof configured>

export function createLocalProviderPlugin<Discovered>(input: {
  readonly id: string
  readonly providerID: string
  readonly name: string
  readonly origin: string
  readonly stripPathSuffix?: RegExp
  readonly discover: (client: LocalDiscoveryClient) => Effect.Effect<readonly Discovered[], unknown>
  readonly model: (item: NoInfer<Discovered>) => LocalModel
}) {
  const discovery = new Map<string, { checked: number; apiKey?: string; models?: readonly Discovered[] }>()
  const discoveryLock = Semaphore.makeUnsafe(1)
  const suffix = input.stripPathSuffix ?? /\/v1$/

  return function make(origin?: string, interval: Duration.Input = "30 seconds") {
    return define({
      id: input.id,
      effect: Effect.fn(function* (ctx) {
        const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
        const config = yield* Config.Service
        const environment = yield* Effect.serviceOption(Environment.Service)
        const location = yield* Effect.serviceOption(Location.Service)
        const defaultOrigin =
          origin ??
          (shellParserWasm.bash === "" ||
          (Option.isSome(location) && location.value.workspaceID !== undefined) ||
          (Option.isSome(environment) && environment.value.spawner === EnvironmentUnavailable.spawner)
            ? undefined
            : input.origin)
        const sources = {
          current: configuredAll(yield* config.entries(), input.providerID, input.name, defaultOrigin, suffix),
        }
        const loaded = new Map<string, { models: readonly Discovered[]; hash: string }>()

        yield* ctx.integration.transform((integrations) => {
          for (const source of sources.current) {
            const state = loaded.get(source.providerID)
            if (!state || state.models.length === 0) continue
            integrations.remove(source.providerID)
          }
        })

        yield* ctx.provider.transform((providers) => {
          for (const source of sources.current) {
            const state = loaded.get(source.providerID)
            if (!state || state.models.length === 0) continue
            for (const model of providers.get(source.providerID)?.models.values() ?? []) {
              providers.models.remove(source.providerID, model.id)
            }
            providers.update(source.providerID, (provider) => {
              provider.name = source.name
              provider.activation = "enabled"
              provider.package = "@opencode/ai/providers/openai-compatible"
              provider.settings = {
                baseURL: source.baseURL,
                provider: input.providerID,
                apiKey: source.apiKey ?? "",
              }
              provider.integrationID = undefined
            })
            for (const item of state.models) {
              const spec = input.model(item)
              providers.models.update(source.providerID, spec.id, (model) => {
                model.modelID = Model.ID.make(spec.id)
                model.name = spec.name || spec.id
                model.family = spec.family ? Model.Family.make(spec.family) : undefined
                model.capabilities = {
                  tools: spec.tools ?? false,
                  input: ["text", ...(spec.vision ? ["image"] : [])],
                  output: ["text"],
                }
                if (typeof spec.context === "number" && spec.context > 0) model.limit.context = spec.context
              })
            }
          }
        })

        const discoverOne = Effect.fn("LocalProviderPlugin.discoverOne")(function* (current: ConfiguredSource) {
          if (!current.endpoint) return undefined
          const endpoint = current.endpoint
          return yield* discoveryLock.withPermit(
            Effect.gen(function* () {
              const cached = discovery.get(current.root)
              if (
                cached &&
                cached.apiKey === current.apiKey &&
                Date.now() - cached.checked < Duration.toMillis(interval)
              )
                return { source: current, models: cached.models }
              discovery.set(current.root, {
                checked: Date.now(),
                apiKey: current.apiKey,
                models: cached && cached.apiKey === current.apiKey ? cached.models : undefined,
              })
              const models = yield* input.discover(createClient(http, current.root, current.apiKey, endpoint))
              discovery.set(current.root, { checked: Date.now(), apiKey: current.apiKey, models })
              return { source: current, models }
            }),
          )
        })

        const refresh = Effect.fn("LocalProviderPlugin.refresh")(function* () {
          const active = sources.current
          let changed = false
          for (const current of active) {
            const result = yield* discoverOne(current).pipe(Effect.option)
            if (Option.isNone(result) || !result.value?.models || !sources.current.includes(current)) continue
            const hash = JSON.stringify(result.value.models)
            const prev = loaded.get(current.providerID) ?? { models: [], hash: "[]" }
            if (prev.hash === hash) continue
            loaded.set(current.providerID, { models: result.value.models, hash })
            changed = true
          }
          if (!changed) return
          yield* ctx.integration.reload()
          yield* ctx.provider.reload()
        })

        // Keep the last successful inventory through transient outages instead of flickering model availability.
        yield* refresh().pipe(Effect.ignore, Effect.repeat(Schedule.spaced(interval)), Effect.forkScoped)
        const reload = Effect.fn("LocalProviderPlugin.reload")(function* () {
          const next = configuredAll(yield* config.entries(), input.providerID, input.name, defaultOrigin, suffix)
          const same =
            next.length === sources.current.length &&
            next.every((item, idx) => {
              const prev = sources.current[idx]
              return (
                prev !== undefined &&
                item.providerID === prev.providerID &&
                item.name === prev.name &&
                item.baseURL === prev.baseURL &&
                item.apiKey === prev.apiKey &&
                item.root === prev.root
              )
            })
          if (same) return
          const prevByID = new Map(sources.current.map((s) => [s.providerID, s]))
          sources.current = next
          const nextIDs = new Set(next.map((s) => s.providerID))
          for (const id of Array.from(loaded.keys())) {
            if (!nextIDs.has(id)) loaded.delete(id)
          }
          for (const item of next) {
            const prev = prevByID.get(item.providerID)
            if (!prev || prev.baseURL !== item.baseURL || prev.apiKey !== item.apiKey || prev.root !== item.root) {
              loaded.delete(item.providerID)
            }
          }
          yield* ctx.integration.reload()
          yield* ctx.provider.reload()
          yield* refresh().pipe(Effect.ignore)
        })
        yield* ctx.event.subscribe().pipe(
          Stream.filter((event) => event.type === "config.updated"),
          Stream.runForEach(reload),
          Effect.forkScoped({ startImmediately: true }),
        )
      }),
    } satisfies PluginInternal.InternalPlugin)
  }
}

function createClient(
  http: HttpClient.HttpClient,
  root: string,
  apiKey: string | undefined,
  endpoint: (path: string) => string,
) {
  const auth = (request: HttpClientRequest.HttpClientRequest) =>
    apiKey
      ? request.pipe(HttpClientRequest.acceptJson, HttpClientRequest.bearerToken(apiKey))
      : request.pipe(HttpClientRequest.acceptJson)
  return {
    root,
    apiKey,
    get: (path: string) => http.execute(auth(HttpClientRequest.get(endpoint(path)))).pipe(Effect.timeout("1 second")),
    getJson: <A, I>(path: string, schema: Schema.Codec<A, I>) =>
      http
        .execute(auth(HttpClientRequest.get(endpoint(path))))
        .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)), Effect.timeout("1 second")),
    postJson: <B, BI, A, AI>(
      path: string,
      bodySchema: Schema.Codec<B, BI>,
      body: B,
      responseSchema: Schema.Codec<A, AI>,
    ) =>
      auth(HttpClientRequest.post(endpoint(path))).pipe(
        HttpClientRequest.schemaBodyJson(bodySchema)(body),
        Effect.flatMap(http.execute),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(responseSchema)),
        Effect.timeout("1 second"),
      ),
  }
}

function configuredAll(
  entries: readonly Entry[],
  providerID: string,
  defaultName: string,
  origin: string | undefined,
  suffix: RegExp,
) {
  const ids = new Set<string>([providerID])
  const names = new Map<string, string>([[providerID, defaultName]])
  for (const entry of entries) {
    if (entry.type !== "document" || !entry.info.providers) continue
    for (const [id, info] of Object.entries(entry.info.providers)) {
      if (id === providerID || id.startsWith(`${providerID}-`) || info.settings?.provider === providerID) {
        ids.add(id)
        if (info.name) names.set(id, info.name)
      }
    }
  }
  return Array.from(ids).map((id) =>
    configured(entries, id, names.get(id) ?? defaultName, id === providerID ? origin : undefined, suffix),
  )
}

function configured(
  entries: readonly Entry[],
  providerID: string,
  name: string,
  origin: string | undefined,
  suffix: RegExp,
) {
  const settings = foldSettings(entries, providerID, undefined)
  const baseURL = (
    typeof settings?.baseURL === "string"
      ? settings.baseURL
      : origin !== undefined
        ? `${origin.replace(/\/+$/, "")}/v1`
        : ""
  ).replace(/\/+$/, "")
  const apiKey = typeof settings?.apiKey === "string" ? settings.apiKey : undefined
  if (!URL.canParse(baseURL)) return { providerID, name, baseURL, apiKey }
  const url = new URL(baseURL)
  if (url.protocol !== "http:" && url.protocol !== "https:") return { providerID, name, baseURL, apiKey }
  const prefix = url.pathname.replace(/\/+$/, "").replace(suffix, "")
  const endpoint = (path: string) => {
    const next = new URL(url)
    next.pathname = `${prefix}${path}`
    next.search = ""
    next.hash = ""
    return next.toString()
  }
  return { providerID, name, baseURL, apiKey, root: endpoint(""), endpoint }
}
