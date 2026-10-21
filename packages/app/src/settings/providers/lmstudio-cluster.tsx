import { Badge } from "@opencode/ui/badge"
import { Button } from "@opencode/ui/button"
import { Switch } from "@opencode/ui/switch"
import { Schema } from "effect"
import { type Component, createEffect, createMemo, createSignal, For, onMount, Show } from "solid-js"
import { Persistence } from "@/runtime/persistence/schema"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { useServerSDK } from "@/runtime/server/client"
import { formatServerError } from "@/runtime/server/errors"
import { showToast } from "@/shell/notifications/toast"
import { SettingsList } from "@/settings/list"

export type LMStudioModelInfo = {
  id: string
  displayName: string
  architecture: string
  state: "loaded" | "not-loaded"
  contextLength: number
  maxContextLength: number
  loadedContextLength?: number
  supportsTools: boolean
  supportsVision: boolean
  isReasoning: boolean
  isCoder: boolean
  paramsBillions: number
  quantization: string
  masterScore: number
  workerScore: number
}

export type LMStudioServerNode = {
  id: string
  providerID: string
  name: string
  host: string
  port: number
  baseUrl: string
  apiBaseUrl: string
  apiKey: string
  online: boolean
  latencyMs?: number
  lastChecked?: number
  error?: string
  models: LMStudioModelInfo[]
}

const ServerEntrySchema = Persistence.struct({
  id: Schema.String,
  providerID: Schema.String,
  name: Schema.String,
  host: Schema.String,
  port: Schema.Number,
  baseUrl: Schema.String,
  apiBaseUrl: Schema.String,
  apiKey: Persistence.fallback(Schema.String, () => ""),
})

const ClusterStoreSchema = Persistence.struct({
  servers: Persistence.array(ServerEntrySchema),
  orchestrationEnabled: Persistence.fallback(Schema.Boolean, () => true),
  masterServerId: Persistence.fallback(Schema.String, () => ""),
  masterModelId: Persistence.fallback(Schema.String, () => ""),
  workerServerId: Persistence.fallback(Schema.String, () => ""),
  workerModelId: Persistence.fallback(Schema.String, () => ""),
})

export function parseLMStudioEndpoint(raw: string): {
  host: string
  port: number
  baseUrl: string
  apiBaseUrl: string
  providerID: string
} | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  let withProto = trimmed
  if (!/^https?:\/\//i.test(withProto)) {
    withProto = `http://${withProto}`
  }
  try {
    const u = new URL(withProto)
    const host = u.hostname
    if (!host) return null
    const port = u.port ? parseInt(u.port, 10) : u.protocol === "https:" ? 443 : 1234
    const apiBaseUrl = `${u.protocol}//${host}:${port}`
    const baseUrl = `${apiBaseUrl}/v1`
    const isLocalDefault = (host === "127.0.0.1" || host === "localhost") && port === 1234
    const slug = `${host}-${port}`.toLowerCase().replace(/[^a-z0-9-_]+/g, "-")
    const providerID = isLocalDefault ? "lmstudio" : `lmstudio-${slug}`
    return { host, port, baseUrl, apiBaseUrl, providerID }
  } catch {
    return null
  }
}

function profileDiscoveredModel(raw: {
  id: string
  displayName?: string
  arch?: string | null
  state?: "loaded" | "not-loaded"
  maxContextLength?: number
  loadedContextLength?: number
  supportsVision?: boolean
  supportsTools?: boolean
}): LMStudioModelInfo {
  const id = raw.id
  const lower = id.toLowerCase()
  const paramMatch =
    lower.match(/(?:^|[-_/])(\d+(?:\.\d+)?)b(?:[-_/]|$)/i) || lower.match(/(\d+)x(\d+(?:\.\d+)?)b/i)
  let paramsBillions = 7
  if (paramMatch) {
    if (paramMatch[2]) {
      paramsBillions = parseFloat(paramMatch[1]) * parseFloat(paramMatch[2]) * 0.6
    } else {
      paramsBillions = parseFloat(paramMatch[1])
    }
  } else if (lower.includes("large") || lower.includes("70b") || lower.includes("72b")) {
    paramsBillions = 70
  } else if (lower.includes("medium") || lower.includes("32b") || lower.includes("34b") || lower.includes("27b")) {
    paramsBillions = 32
  } else if (lower.includes("mini") || lower.includes("small") || lower.includes("3b") || lower.includes("1.5b")) {
    paramsBillions = 3
  }

  const quantMatch = id.match(/(Q[2-8]_[A-Z0-9_]+|FP16|BF16|FP8|INT4|INT8|4bit|8bit|AWQ|GPTQ)/i)
  const quantization = quantMatch ? quantMatch[1].toUpperCase() : "GGUF/Auto"

  const isReasoning = /r1|qwq|reason|think|o1|o3|marco-o1|sky-t1|deepseek-r1/i.test(lower)
  const isCoder = /coder|codestral|starcoder|deepseek-coder|devstral|qwen.*coder|code/i.test(lower)
  const supportsVision = Boolean(raw.supportsVision) || /vl|vision|llava|pixtral|minicpm-v|qwen2-vl|gemma-3|gemma-4/i.test(lower)
  const supportsTools =
    raw.supportsTools !== undefined
      ? raw.supportsTools
      : /qwen|llama-3\.[123]|mistral|codestral|deepseek|claude|gpt|command-r|hermes|function|tool|gemma-4/i.test(lower)

  const maxContextLength =
    raw.maxContextLength && raw.maxContextLength > 0
      ? raw.maxContextLength
      : /128k|qwen2\.5|llama-3\.[123]|deepseek|mistral-nemo|gemma/i.test(lower)
        ? 65536
        : 32768
  const loadedContextLength =
    raw.loadedContextLength && raw.loadedContextLength > 0 ? raw.loadedContextLength : undefined
  const contextLength = loadedContextLength ?? maxContextLength
  const state = raw.state ?? (loadedContextLength ? "loaded" : "not-loaded")

  const loadedBonus = state === "loaded" ? 45 : 0
  const ctxScore = Math.min(contextLength / 2048, 32)
  const masterScore = Math.round(
    loadedBonus +
      paramsBillions * 1.4 +
      (isReasoning ? 28 : 0) +
      (isCoder ? 20 : 0) +
      (supportsTools ? 25 : 0) +
      ctxScore,
  )
  const speedFactor = paramsBillions <= 14 ? 32 : paramsBillions <= 35 ? 24 : 12
  const workerScore = Math.round(
    loadedBonus + speedFactor + (isCoder ? 35 : 0) + (supportsTools ? 28 : 0) + Math.min(contextLength / 4096, 20),
  )

  return {
    id,
    displayName: raw.displayName || id,
    architecture: raw.arch || (isCoder ? "coder" : "llm"),
    state,
    contextLength,
    maxContextLength,
    loadedContextLength,
    supportsTools,
    supportsVision,
    isReasoning,
    isCoder,
    paramsBillions,
    quantization,
    masterScore,
    workerScore,
  }
}

async function fetchWithTimeout(url: string, apiKey: string, timeoutMs = 2800): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers: Record<string, string> = { Accept: "application/json" }
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`
    return await fetch(url, { signal: controller.signal, headers })
  } finally {
    clearTimeout(timer)
  }
}

export async function probeLMStudioNode(entry: {
  id: string
  providerID: string
  name: string
  host: string
  port: number
  baseUrl: string
  apiBaseUrl: string
  apiKey: string
}): Promise<LMStudioServerNode> {
  const start = performance.now()
  try {
    // 1. Try LM Studio native /api/v1/models first (richest metadata: loaded_instances, capabilities, max_context_length)
    const v1Res = await fetchWithTimeout(`${entry.apiBaseUrl}/api/v1/models`, entry.apiKey, 2800).catch(() => null)
    if (v1Res && v1Res.ok) {
      const latencyMs = Math.round(performance.now() - start)
      const json = (await v1Res.json()) as {
        models?: Array<{
          type?: string
          key?: string
          display_name?: string
          architecture?: string | null
          loaded_instances?: Array<{ config?: { context_length?: number } }>
          max_context_length?: number
          capabilities?: { vision?: boolean; trained_for_tool_use?: boolean }
        }>
      }
      if (Array.isArray(json.models)) {
        const models = json.models
          .filter((m) => m.type !== "embedding" && m.type !== "embeddings" && Boolean(m.key))
          .map((m) => {
            const loadedCtxs = (m.loaded_instances ?? [])
              .map((inst) => inst.config?.context_length)
              .filter((c): c is number => typeof c === "number" && c > 0)
            const loadedContextLength = loadedCtxs.length > 0 ? Math.min(...loadedCtxs) : undefined
            return profileDiscoveredModel({
              id: m.key!,
              displayName: m.display_name || m.key!,
              arch: m.architecture,
              state: (m.loaded_instances?.length ?? 0) > 0 ? "loaded" : "not-loaded",
              maxContextLength: m.max_context_length,
              loadedContextLength,
              supportsVision: m.capabilities?.vision,
              supportsTools: m.capabilities?.trained_for_tool_use,
            })
          })
          .sort((a, b) => Number(b.state === "loaded") - Number(a.state === "loaded") || b.masterScore - a.masterScore)

        return {
          ...entry,
          online: true,
          latencyMs,
          lastChecked: Date.now(),
          models,
        }
      }
    }

    // 2. Fallback to LM Studio REST API v0 (/api/v0/models)
    const v0Res = await fetchWithTimeout(`${entry.apiBaseUrl}/api/v0/models`, entry.apiKey, 2500).catch(() => null)
    if (v0Res && v0Res.ok) {
      const latencyMs = Math.round(performance.now() - start)
      const json = (await v0Res.json()) as {
        data?: Array<{
          id: string
          type?: string
          arch?: string | null
          state?: string
          max_context_length?: number
          loaded_context_length?: number
          capabilities?: string[]
        }>
      }
      if (Array.isArray(json.data)) {
        const models = json.data
          .filter((m) => m.type !== "embeddings" && m.type !== "embedding" && Boolean(m.id))
          .map((m) =>
            profileDiscoveredModel({
              id: m.id,
              displayName: m.id,
              arch: m.arch,
              state: m.state === "loaded" || (m.loaded_context_length && m.loaded_context_length > 0) ? "loaded" : "not-loaded",
              maxContextLength: m.max_context_length,
              loadedContextLength: m.loaded_context_length,
              supportsVision: m.type === "vlm" || m.capabilities?.includes("vision"),
              supportsTools: m.capabilities?.includes("tool_use"),
            }),
          )
          .sort((a, b) => Number(b.state === "loaded") - Number(a.state === "loaded") || b.masterScore - a.masterScore)

        return {
          ...entry,
          online: true,
          latencyMs,
          lastChecked: Date.now(),
          models,
        }
      }
    }

    // 3. Fallback to standard OpenAI-compatible /v1/models
    const oaiRes = await fetchWithTimeout(`${entry.baseUrl}/models`, entry.apiKey, 2500)
    if (!oaiRes.ok) {
      throw new Error(`HTTP ${oaiRes.status}`)
    }
    const latencyMs = Math.round(performance.now() - start)
    const oaiJson = (await oaiRes.json()) as { data?: Array<{ id: string }> }
    const models = (oaiJson.data ?? [])
      .filter((m) => Boolean(m.id) && !/embed|nomic|bge-/i.test(m.id))
      .map((m) =>
        profileDiscoveredModel({
          id: m.id,
          displayName: m.id,
          state: "loaded",
        }),
      )
      .sort((a, b) => b.masterScore - a.masterScore)

    return {
      ...entry,
      online: true,
      latencyMs,
      lastChecked: Date.now(),
      models,
    }
  } catch (err: unknown) {
    return {
      ...entry,
      online: false,
      lastChecked: Date.now(),
      error: err instanceof Error ? err.message : "Unreachable",
      models: [],
    }
  }
}

function formatCtx(tokens: number): string {
  if (!tokens || tokens <= 0) return "Auto"
  if (tokens >= 1024) return `${Math.round(tokens / 1024)}K ctx`
  return `${tokens} ctx`
}

export const LMStudioClusterSection: Component<{
  directory: string | undefined
}> = (props) => {
  const serverSdk = useServerSDK()

  const [store, setStore] = persisted(
    Persist.serverGlobal(serverSdk.scope, "settings-v2.lmstudio.cluster"),
    ClusterStoreSchema,
    {
      servers: [
        {
          id: "lmstudio-local",
          providerID: "lmstudio",
          name: "LM Studio (Local)",
          host: "127.0.0.1",
          port: 1234,
          baseUrl: "http://127.0.0.1:1234/v1",
          apiBaseUrl: "http://127.0.0.1:1234",
          apiKey: "",
        },
      ],
      orchestrationEnabled: true,
      masterServerId: "",
      masterModelId: "",
      workerServerId: "",
      workerModelId: "",
    },
  )

  const [nodes, setNodes] = createSignal<Record<string, LMStudioServerNode>>({})
  const [endpointInput, setEndpointInput] = createSignal("")
  const [nameInput, setNameInput] = createSignal("")
  const [probing, setProbing] = createSignal(false)
  const [scanningLan, setScanningLan] = createSignal(false)
  const [syncing, setSyncing] = createSignal(false)

  const serverList = createMemo(() =>
    store.servers.map(
      (s) =>
        nodes()[s.id] ?? {
          ...s,
          online: false,
          models: [],
        },
    ),
  )

  const onlineServers = createMemo(() => serverList().filter((s) => s.online && s.models.length > 0))

  const allAvailableChoices = createMemo(() => {
    const list: Array<{
      server: LMStudioServerNode
      model: LMStudioModelInfo
      key: string
    }> = []
    for (const s of onlineServers()) {
      for (const m of s.models) {
        list.push({
          server: s,
          model: m,
          key: `${s.id}::${m.id}`,
        })
      }
    }
    return list
  })

  const autoElectRoles = (discoveredNodes: LMStudioServerNode[]) => {
    const active = discoveredNodes.filter((n) => n.online && n.models.length > 0)
    if (active.length === 0) return

    // Pick best Master across all online servers
    let bestMaster: { server: LMStudioServerNode; model: LMStudioModelInfo } | undefined
    for (const s of active) {
      for (const m of s.models) {
        if (!bestMaster || m.masterScore > bestMaster.model.masterScore) {
          bestMaster = { server: s, model: m }
        }
      }
    }

    if (!bestMaster) return

    // If 2+ servers are online, strongly prefer placing the Worker (Agent) on a DIFFERENT server for true parallel GPU execution
    let bestWorker: { server: LMStudioServerNode; model: LMStudioModelInfo } | undefined
    const otherServers = active.filter((s) => s.id !== bestMaster!.server.id)
    const workerPool = otherServers.length > 0 ? otherServers : active

    for (const s of workerPool) {
      for (const m of s.models) {
        if (!bestWorker || m.workerScore > bestWorker.model.workerScore) {
          bestWorker = { server: s, model: m }
        }
      }
    }

    if (!store.masterServerId || !active.some((s) => s.id === store.masterServerId)) {
      setStore("masterServerId", bestMaster.server.id)
      setStore("masterModelId", bestMaster.model.id)
    }
    if (bestWorker && (!store.workerServerId || !active.some((s) => s.id === store.workerServerId))) {
      setStore("workerServerId", bestWorker.server.id)
      setStore("workerModelId", bestWorker.model.id)
    }
  }

  const syncToOpenCodeConfig = async (
    currentNodes: LMStudioServerNode[],
    silent = false,
  ) => {
    const active = currentNodes.filter((n) => n.online && n.models.length > 0)
    if (active.length === 0) return

    setSyncing(true)
    try {
      const providersPatch: Record<string, unknown> = {}
      for (const node of active) {
        const modelsMap: Record<string, unknown> = {}
        for (const m of node.models) {
          modelsMap[m.id] = {
            name: `${m.displayName} (${formatCtx(m.contextLength)})`,
            limit: {
              context: m.contextLength,
              output: Math.min(32000, Math.max(4096, Math.floor(m.contextLength / 2))),
            },
            capabilities: {
              tools: m.supportsTools,
              input: m.supportsVision ? ["text", "image"] : ["text"],
              output: ["text"],
            },
          }
        }
        providersPatch[node.providerID] = {
          name: node.name,
          package: "@opencode/ai/providers/openai-compatible",
          settings: {
            baseURL: node.baseUrl,
            provider: "lmstudio",
            apiKey: node.apiKey || "lm-studio",
          },
          models: modelsMap,
        }
      }

      const masterNode = active.find((n) => n.id === store.masterServerId) ?? active[0]
      const masterModel =
        masterNode?.models.find((m) => m.id === store.masterModelId) ?? masterNode?.models[0]

      const workerNode =
        active.find((n) => n.id === store.workerServerId) ??
        active.find((n) => n.id !== masterNode?.id) ??
        masterNode
      const workerModel =
        workerNode?.models.find((m) => m.id === store.workerModelId) ?? workerNode?.models[0]

      const patchPayload: {
        directory?: string
        providers?: Record<string, unknown>
        model?: { providerID: string; model: string }
        default_agent?: string
        agents?: Record<string, unknown>
      } = {
        directory: props.directory,
        providers: providersPatch,
      }

      if (masterNode && masterModel) {
        patchPayload.model = {
          providerID: masterNode.providerID,
          model: masterModel.id,
        }
        patchPayload.default_agent = "build"
      }

      if (store.orchestrationEnabled && masterNode && masterModel && workerNode && workerModel) {
        const dualNodeNote =
          masterNode.id !== workerNode.id
            ? `You are the MASTER Architect running on ${masterNode.name} (${masterModel.displayName}). You have a dedicated secondary WORKER LM Studio server on ${workerNode.name} (${workerModel.displayName}) available via delegation tools: \`delegate_task\`, \`delegate\`, or \`subagent\` (agents: "worker", "general", "explore"). Proactively delegate coding, file exploration, and parallelizable implementation tasks to the subagent/worker node so both LM Studio servers work in tandem.`
            : `You are the MASTER Architect (${masterModel.displayName}). Delegate focused exploration and coding subtasks via the \`delegate_task\` or \`subagent\` tool to the worker agent (${workerModel.displayName}).`

        patchPayload.agents = {
          build: {
            mode: "primary",
            model: {
              providerID: masterNode.providerID,
              model: masterModel.id,
            },
            description: `Master Architect (${masterNode.name} · ${masterModel.displayName})`,
            permission: {
              subagent: "allow",
              delegate: "allow",
              delegate_task: "allow",
            },
            system: `${dualNodeNote} You have full delegation capabilities via \`delegate_task\`, \`delegate\`, and \`subagent\`. When searching for tools in CodeMode, \`search({ query: 'delegate' })\` returns the delegation tools. You can also call them directly: \`await delegate_task({ task: "...", agent: "worker" })\`, \`await delegate({ task: "...", agent: "worker" })\`, or \`await tools.delegate({ task: "...", agent: "worker" })\`. Always use these delegation tools to delegate tasks to the worker node. NEVER claim you do not have delegation tools or subagents available.`,
          },
          worker: {
            mode: "subagent",
            model: {
              providerID: workerNode.providerID,
              model: workerModel.id,
            },
            description: `Dedicated Worker Agent on ${workerNode.name} (${workerModel.displayName}) for code implementation and execution.`,
            system: `You are the dedicated Worker Subagent running on ${workerNode.name}. Execute assigned coding, debugging, and analysis tasks accurately and concisely, then report results back to the Master agent.`,
          },
          general: {
            mode: "subagent",
            model: {
              providerID: workerNode.providerID,
              model: workerModel.id,
            },
            description: `General Subagent routed to Worker server ${workerNode.name} (${workerModel.displayName})`,
          },
          explore: {
            mode: "subagent",
            model: {
              providerID: workerNode.providerID,
              model: workerModel.id,
            },
            description: `Codebase Explorer Subagent routed to Worker server ${workerNode.name} (${workerModel.displayName})`,
          },
        }
      }

      await serverSdk.api.config.update(patchPayload as Parameters<typeof serverSdk.api.config.update>[0])

      if (!silent) {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: "LM Studio Cluster Synced",
          description:
            store.orchestrationEnabled && masterNode && workerNode
              ? `Master: ${masterNode.name} (${masterModel?.displayName}) ⇄ Agent: ${workerNode.name} (${workerModel?.displayName})`
              : `Synced ${active.length} LM Studio server(s) to OpenCode.`,
        })
      }
    } catch (err) {
      if (!silent) {
        showToast({
          variant: "error",
          title: "Failed to sync LM Studio config",
          description: formatServerError(err),
        })
      }
    } finally {
      setSyncing(false)
    }
  }

  const refreshAllServers = async (autoSync = true) => {
    setProbing(true)
    try {
      const results = await Promise.all(store.servers.map((entry) => probeLMStudioNode(entry)))
      const nextMap: Record<string, LMStudioServerNode> = {}
      for (const r of results) {
        nextMap[r.id] = r
      }
      setNodes(nextMap)
      autoElectRoles(results)
      if (autoSync && results.some((r) => r.online && r.models.length > 0)) {
        await syncToOpenCodeConfig(results, true)
      }
    } finally {
      setProbing(false)
    }
  }

  const addServer = async (e?: Event) => {
    e?.preventDefault()
    const parsed = parseLMStudioEndpoint(endpointInput())
    if (!parsed) {
      showToast({
        variant: "error",
        title: "Invalid Server Address",
        description: "Enter an IP:Port or URL (e.g. 192.168.0.25:1234 or 127.0.0.1:1234)",
      })
      return
    }

    const existing = store.servers.find(
      (s) => s.host === parsed.host && s.port === parsed.port,
    )
    const id = existing?.id ?? `lms-${parsed.host}-${parsed.port}`.replace(/[^a-z0-9-_]/gi, "-")
    const label =
      nameInput().trim() ||
      existing?.name ||
      (parsed.host === "127.0.0.1" || parsed.host === "localhost"
        ? `LM Studio (Local :${parsed.port})`
        : `LM Studio (${parsed.host}:${parsed.port})`)

    const entry = {
      id,
      providerID: parsed.providerID,
      name: label,
      host: parsed.host,
      port: parsed.port,
      baseUrl: parsed.baseUrl,
      apiBaseUrl: parsed.apiBaseUrl,
      apiKey: "",
    }

    if (!existing) {
      setStore("servers", [...store.servers, entry])
    } else {
      setStore(
        "servers",
        store.servers.map((s) => (s.id === existing.id ? entry : s)),
      )
    }

    setEndpointInput("")
    setNameInput("")

    setProbing(true)
    try {
      const probed = await probeLMStudioNode(entry)
      const updatedNodes = { ...nodes(), [probed.id]: probed }
      setNodes(updatedNodes)
      const list = store.servers.map((s) => updatedNodes[s.id] ?? { ...s, online: false, models: [] })
      autoElectRoles(list)

      if (probed.online) {
        await syncToOpenCodeConfig(list, false)
      } else {
        showToast({
          variant: "error",
          title: `Added ${entry.name} (Offline)`,
          description: `Could not reach ${entry.apiBaseUrl}. Ensure LM Studio Local Server is running with CORS/network enabled.`,
        })
      }
    } finally {
      setProbing(false)
    }
  }

  const removeServer = async (id: string) => {
    const next = store.servers.filter((s) => s.id !== id)
    setStore("servers", next)
    const copy = { ...nodes() }
    delete copy[id]
    setNodes(copy)
    const remainingNodes = next.map((s) => copy[s.id]).filter((n): n is LMStudioServerNode => Boolean(n))
    autoElectRoles(remainingNodes)
    if (remainingNodes.some((n) => n.online)) {
      await syncToOpenCodeConfig(remainingNodes, true)
    }
  }

  const scanLocalAndLan = async () => {
    setScanningLan(true)
    try {
      const candidates = new Set<string>(["127.0.0.1:1234"])
      // Collect /24 subnets from any already-configured LAN server IPs
      const prefixes = new Set<string>(["192.168.0", "192.168.1"])
      for (const s of store.servers) {
        const m = s.host.match(/^(\d+\.\d+\.\d+)\.\d+$/)
        if (m && m[1] !== "127.0.0") prefixes.add(m[1])
      }
      for (const prefix of prefixes) {
        for (let i = 1; i <= 254; i++) {
          candidates.add(`${prefix}.${i}:1234`)
        }
      }

      const items = Array.from(candidates)
      const discovered: typeof store.servers = [...store.servers]
      const discoveredNodes: Record<string, LMStudioServerNode> = { ...nodes() }
      let foundNew = 0

      // Probe in batches of 32 for fast LAN discovery
      const batchSize = 32
      for (let i = 0; i < items.length; i += batchSize) {
        const slice = items.slice(i, i + batchSize)
        await Promise.all(
          slice.map(async (addr) => {
            const parsed = parseLMStudioEndpoint(addr)
            if (!parsed) return
            const entry = {
              id:
                parsed.host === "127.0.0.1" && parsed.port === 1234
                  ? "lmstudio-local"
                  : `lms-${parsed.host}-${parsed.port}`.replace(/[^a-z0-9-_]/gi, "-"),
              providerID: parsed.providerID,
              name:
                parsed.host === "127.0.0.1"
                  ? "LM Studio (Local)"
                  : `LM Studio (${parsed.host}:${parsed.port})`,
              host: parsed.host,
              port: parsed.port,
              baseUrl: parsed.baseUrl,
              apiBaseUrl: parsed.apiBaseUrl,
              apiKey: "",
            }
            const res = await probeLMStudioNode(entry)
            if (res.online && res.models.length > 0) {
              discoveredNodes[res.id] = res
              if (!discovered.some((d) => d.host === res.host && d.port === res.port)) {
                discovered.push(entry)
                foundNew++
              }
            }
          }),
        )
      }

      setStore("servers", discovered)
      setNodes(discoveredNodes)
      const allList = discovered.map((s) => discoveredNodes[s.id] ?? { ...s, online: false, models: [] })
      autoElectRoles(allList)
      await syncToOpenCodeConfig(allList, true)

      const onlineCount = allList.filter((s) => s.online).length
      showToast({
        variant: "success",
        icon: "circle-check",
        title: `Discovery Complete (${onlineCount} server${onlineCount === 1 ? "" : "s"} online)`,
        description:
          foundNew > 0
            ? `Discovered ${foundNew} new LM Studio server(s) on your network and auto-configured models & context!`
            : `Refreshed ${onlineCount} active LM Studio server(s).`,
      })
    } finally {
      setScanningLan(false)
    }
  }

  const autoAssignBestMasterAndWorker = async () => {
    const active = onlineServers()
    if (active.length === 0) return

    let bestMaster: { server: LMStudioServerNode; model: LMStudioModelInfo } | undefined
    for (const s of active) {
      for (const m of s.models) {
        if (!bestMaster || m.masterScore > bestMaster.model.masterScore) {
          bestMaster = { server: s, model: m }
        }
      }
    }
    if (!bestMaster) return

    const otherServers = active.filter((s) => s.id !== bestMaster!.server.id)
    const workerPool = otherServers.length > 0 ? otherServers : active
    let bestWorker: { server: LMStudioServerNode; model: LMStudioModelInfo } | undefined
    for (const s of workerPool) {
      for (const m of s.models) {
        if (
          active.length === 1 &&
          s.models.length > 1 &&
          m.id === bestMaster.model.id
        ) {
          continue
        }
        if (!bestWorker || m.workerScore > bestWorker.model.workerScore) {
          bestWorker = { server: s, model: m }
        }
      }
    }
    if (!bestWorker) bestWorker = bestMaster

    setStore("orchestrationEnabled", true)
    setStore("masterServerId", bestMaster.server.id)
    setStore("masterModelId", bestMaster.model.id)
    setStore("workerServerId", bestWorker.server.id)
    setStore("workerModelId", bestWorker.model.id)

    await syncToOpenCodeConfig(serverList(), false)
  }

  onMount(() => {
    void refreshAllServers(true)
  })

  createEffect(() => {
    // Ensure valid selections whenever online servers change
    const active = onlineServers()
    if (active.length > 0 && (!store.masterServerId || ! store.masterModelId)) {
      autoElectRoles(active)
    }
  })

  return (
    <div class="settings-section" data-component="lmstudio-cluster-section">
      <div class="flex items-center justify-between gap-2 pb-2">
        <div class="flex flex-col gap-0.5">
          <div class="flex items-center gap-2">
            <h3 class="settings-section-title" style={{ margin: 0 }}>
              LM Studio Multi-Server & Master ⇄ Agent Orchestrator
            </h3>
            <Badge>
              {onlineServers().length} / {store.servers.length} Online
            </Badge>
          </div>
          <p class="text-11-regular text-v2-text-text-muted">
            Add one or more LM Studio servers by IP:Port. Automatically detects loaded models, effective context window, and tool/vision capabilities. With 2+ servers, run one as Master (Architect) and the other as Agent (Worker).
          </p>
        </div>

        <div class="flex items-center gap-2 shrink-0">
          <Button
            size="normal"
            variant="ghost-muted"
            onClick={() => void scanLocalAndLan()}
            disabled={scanningLan() || probing()}
          >
            {scanningLan() ? "Scanning LAN..." : "Scan LAN"}
          </Button>
          <Button
            size="normal"
            variant="neutral"
            onClick={() => void refreshAllServers(false)}
            disabled={probing() || scanningLan()}
          >
            {probing() ? "Probing..." : "Refresh All"}
          </Button>
        </div>
      </div>

      {/* Add Server Form */}
      <SettingsList variant="catalog">
        <form onSubmit={(e) => void addServer(e)} class="settings-provider-row flex-wrap gap-2 py-3">
          <div class="flex flex-1 flex-wrap items-center gap-2 min-w-[260px]">
            <input
              type="text"
              value={endpointInput()}
              onInput={(e) => setEndpointInput(e.currentTarget.value)}
              placeholder="Server IP:Port (e.g. 192.168.0.25:1234 or 192.168.0.200:1234)"
              class="flex-1 min-w-[210px] h-8 px-2.5 rounded border border-border-weak-base bg-surface-base text-13-regular text-text-strong focus:outline-none focus:border-border-strong-base"
            />
            <input
              type="text"
              value={nameInput()}
              onInput={(e) => setNameInput(e.currentTarget.value)}
              placeholder="Label (optional, e.g. GPU Server 1)"
              class="w-48 h-8 px-2.5 rounded border border-border-weak-base bg-surface-base text-13-regular text-text-strong focus:outline-none focus:border-border-strong-base"
            />
          </div>
          <Button type="submit" size="normal" variant="neutral" icon="plus" disabled={probing()}>
            Add & Discover Server
          </Button>
        </form>
      </SettingsList>

      {/* Master ⇄ Agent Multi-Server Orchestrator Panel */}
      <Show when={onlineServers().length > 0}>
        <div class="mt-3">
          <SettingsList variant="catalog">
            <div class="flex flex-col gap-3 p-3.5">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="flex items-center gap-2">
                  <span class="text-13-medium text-text-strong">
                    Master ⇄ Agent (Worker) Multi-Server Orchestration
                  </span>
                  <Show when={onlineServers().length >= 2}>
                    <Badge>Dual-Server Ready ({onlineServers().length} Nodes)</Badge>
                  </Show>
                </div>

                <div class="flex items-center gap-3">
                  <Button
                    size="normal"
                    variant="ghost-muted"
                    onClick={() => void autoAssignBestMasterAndWorker()}
                    disabled={syncing()}
                  >
                    Auto-Elect Best Master & Agent
                  </Button>
                  <Switch
                    checked={store.orchestrationEnabled}
                    onChange={(checked) => {
                      setStore("orchestrationEnabled", checked)
                      void syncToOpenCodeConfig(serverList(), false)
                    }}
                    hideLabel
                  >
                    Enable Master/Agent
                  </Switch>
                </div>
              </div>

              <Show when={store.orchestrationEnabled}>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
                  {/* MASTER ROLE SELECTOR */}
                  <div class="flex flex-col gap-1.5 p-2.5 rounded border border-border-weak-base bg-surface-base">
                    <div class="flex items-center justify-between">
                      <span class="text-12-medium text-text-strong">👑 Master Server & Model (Primary Architect)</span>
                      <Badge>Primary / Build</Badge>
                    </div>
                    <span class="text-11-regular text-v2-text-text-muted">
                      Plans architecture, coordinates reasoning, and delegates tasks to Agent.
                    </span>
                    <select
                      class="mt-1 h-8 px-2 rounded border border-border-weak-base bg-background-base text-12-regular text-text-strong"
                      value={`${store.masterServerId}::${store.masterModelId}`}
                      onChange={(e) => {
                        const [sId, mId] = e.currentTarget.value.split("::")
                        if (sId && mId) {
                          setStore("masterServerId", sId)
                          setStore("masterModelId", mId)
                          void syncToOpenCodeConfig(serverList(), false)
                        }
                      }}
                    >
                      <For each={allAvailableChoices()}>
                        {(choice) => (
                          <option value={choice.key}>
                            [{choice.server.name}] {choice.model.displayName} — {formatCtx(choice.model.contextLength)}{" "}
                            {choice.model.state === "loaded" ? "● LOADED" : "○ Unloaded"} (Score {choice.model.masterScore})
                          </option>
                        )}
                      </For>
                    </select>
                  </div>

                  {/* WORKER / AGENT ROLE SELECTOR */}
                  <div class="flex flex-col gap-1.5 p-2.5 rounded border border-border-weak-base bg-surface-base">
                    <div class="flex items-center justify-between">
                      <span class="text-12-medium text-text-strong">⚡ Agent / Worker Server & Model (Subagent)</span>
                      <Badge>Subagent / Worker</Badge>
                    </div>
                    <span class="text-11-regular text-v2-text-text-muted">
                      Executes code edits, searches, and parallel subagent tasks delegated by Master.
                    </span>
                    <select
                      class="mt-1 h-8 px-2 rounded border border-border-weak-base bg-background-base text-12-regular text-text-strong"
                      value={`${store.workerServerId}::${store.workerModelId}`}
                      onChange={(e) => {
                        const [sId, mId] = e.currentTarget.value.split("::")
                        if (sId && mId) {
                          setStore("workerServerId", sId)
                          setStore("workerModelId", mId)
                          void syncToOpenCodeConfig(serverList(), false)
                        }
                      }}
                    >
                      <For each={allAvailableChoices()}>
                        {(choice) => (
                          <option value={choice.key}>
                            [{choice.server.name}] {choice.model.displayName} — {formatCtx(choice.model.contextLength)}{" "}
                            {choice.model.state === "loaded" ? "● LOADED" : "○ Unloaded"} (Score {choice.model.workerScore})
                          </option>
                        )}
                      </For>
                    </select>
                  </div>
                </div>

                <div class="flex items-center justify-between pt-1">
                  <span class="text-11-regular text-v2-text-text-muted">
                    <Show
                      when={store.masterServerId && store.workerServerId && store.masterServerId !== store.workerServerId}
                      fallback="Single-node or custom routing active. Add a 2nd LM Studio server to split Master and Agent across GPUs."
                    >
                      Dual-Server Active: Master and Agent run on separate LM Studio machines simultaneously!
                    </Show>
                  </span>
                  <Button
                    size="normal"
                    variant="neutral"
                    onClick={() => void syncToOpenCodeConfig(serverList(), false)}
                    disabled={syncing()}
                  >
                    {syncing() ? "Syncing..." : "Apply & Sync Configuration"}
                  </Button>
                </div>
              </Show>
            </div>
          </SettingsList>
        </div>
      </Show>

      {/* Discovered Servers & Models List */}
      <div class="mt-3 flex flex-col gap-2.5">
        <For each={serverList()}>
          {(server) => {
            const isMasterServer = () => store.orchestrationEnabled && store.masterServerId === server.id
            const isWorkerServer = () => store.orchestrationEnabled && store.workerServerId === server.id

            return (
              <SettingsList variant="catalog">
                <div class="flex flex-col gap-2.5 p-3">
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <div class="flex items-center gap-2.5 min-w-0">
                      <span
                        class="inline-block size-2.5 rounded-full shrink-0"
                        style={{
                          "background-color": server.online ? "#22c55e" : "#ef4444",
                        }}
                        title={server.online ? "Online" : "Offline"}
                      />
                      <span class="settings-provider-name truncate">{server.name}</span>
                      <Badge>{server.baseUrl}</Badge>
                      <Show when={server.online && server.latencyMs !== undefined}>
                        <Badge>{server.latencyMs} ms</Badge>
                      </Show>
                      <Show when={isMasterServer()}>
                        <Badge>👑 MASTER NODE</Badge>
                      </Show>
                      <Show when={isWorkerServer()}>
                        <Badge>⚡ AGENT NODE</Badge>
                      </Show>
                    </div>

                    <div class="flex items-center gap-1.5">
                      <Button
                        size="normal"
                        variant="ghost-muted"
                        onClick={async () => {
                          const updated = await probeLMStudioNode(server)
                          setNodes((prev) => ({ ...prev, [server.id]: updated }))
                          if (updated.online) {
                            await syncToOpenCodeConfig(
                              serverList().map((s) => (s.id === server.id ? updated : s)),
                              false,
                            )
                          }
                        }}
                      >
                        Probe
                      </Button>
                      <Show when={store.servers.length > 1 || server.id !== "lmstudio-local"}>
                        <Button
                          size="normal"
                          variant="ghost-muted"
                          onClick={() => void removeServer(server.id)}
                        >
                          Remove
                        </Button>
                      </Show>
                    </div>
                  </div>

                  <Show
                    when={server.online && server.models.length > 0}
                    fallback={
                      <div class="text-12-regular text-v2-text-text-muted py-1">
                        {server.online
                          ? "Server online, but no LLM models reported by LM Studio."
                          : `Server unreachable at ${server.apiBaseUrl} (${server.error || "offline"}). Start LM Studio server or check IP/Port.`}
                      </div>
                    }
                  >
                    <div class="flex flex-col gap-1.5 border-t border-border-weak-base pt-2">
                      <For each={server.models}>
                        {(model) => {
                          const isSelectedMaster = () =>
                            store.masterServerId === server.id && store.masterModelId === model.id
                          const isSelectedWorker = () =>
                            store.workerServerId === server.id && store.workerModelId === model.id

                          return (
                            <div class="flex flex-wrap items-center justify-between gap-2 py-1.5 px-2 rounded hover:bg-surface-base">
                              <div class="flex flex-wrap items-center gap-1.5 min-w-0">
                                <span
                                  class="inline-block size-2 rounded-full shrink-0"
                                  style={{
                                    "background-color": model.state === "loaded" ? "#22c55e" : "#94a3b8",
                                  }}
                                  title={model.state === "loaded" ? "Loaded in VRAM" : "Available on Disk"}
                                />
                                <span class="text-12-medium text-text-strong truncate">{model.displayName}</span>
                                <Badge>{formatCtx(model.contextLength)}</Badge>
                                <Show when={model.loadedContextLength && model.maxContextLength > model.loadedContextLength}>
                                  <span class="text-11-regular text-v2-text-text-muted">
                                    (max {formatCtx(model.maxContextLength)})
                                  </span>
                                </Show>
                                <Show when={model.state === "loaded"}>
                                  <Badge>LOADED</Badge>
                                </Show>
                                <Show when={model.supportsTools}>
                                  <Badge>TOOLS</Badge>
                                </Show>
                                <Show when={model.supportsVision}>
                                  <Badge>VISION</Badge>
                                </Show>
                                <Show when={model.isCoder}>
                                  <Badge>CODER</Badge>
                                </Show>
                                <Show when={model.isReasoning}>
                                  <Badge>REASONING</Badge>
                                </Show>
                              </div>

                              <div class="flex items-center gap-1.5 shrink-0">
                                <Button
                                  size="normal"
                                  variant={isSelectedMaster() ? "neutral" : "ghost-muted"}
                                  onClick={() => {
                                    setStore("masterServerId", server.id)
                                    setStore("masterModelId", model.id)
                                    void syncToOpenCodeConfig(serverList(), false)
                                  }}
                                >
                                  {isSelectedMaster() ? "👑 Master" : "Set Master"}
                                </Button>
                                <Button
                                  size="normal"
                                  variant={isSelectedWorker() ? "neutral" : "ghost-muted"}
                                  onClick={() => {
                                    setStore("orchestrationEnabled", true)
                                    setStore("workerServerId", server.id)
                                    setStore("workerModelId", model.id)
                                    void syncToOpenCodeConfig(serverList(), false)
                                  }}
                                >
                                  {isSelectedWorker() ? "⚡ Agent" : "Set Agent"}
                                </Button>
                              </div>
                            </div>
                          )
                        }}
                      </For>
                    </div>
                  </Show>
                </div>
              </SettingsList>
            )
          }}
        </For>
      </div>
    </div>
  )
}
