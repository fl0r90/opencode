export * as SubagentTool from "./subagent.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import type { Context as ToolContext } from "@opencode/schema/tool"
import { Effect, Predicate, Schema } from "effect"
import { Agent } from "../../agent.js"
import { Config } from "../../config.js"
import { Job } from "../../job.js"
import { Model } from "../../model.js"
import { Permission } from "../../permission.js"
import { Session } from "../../session.js"
import { SessionSchema } from "../../session/schema.js"
import { SubagentCompletion } from "../../session/subagent-completion.js"
import { SubagentJob } from "../../session/subagent-job.js"

export const name = "subagent"

const backgroundResult = (sessionID: SessionSchema.ID) => ({
  sessionID,
  status: "running" as const,
  output: [
    `The subagent is working in the background (sessionID: ${sessionID}). You will be notified automatically when it finishes.`,
    "DO NOT sleep, poll for progress, ask the subagent for status, or duplicate this subagent's work; avoid working with the same files or topics it is using.",
    "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
  ].join("\n"),
})

export const Input = Schema.Struct({
  agent: Schema.optionalKey(Schema.String).annotate({
    description:
      "The type of specialized agent to use for this task (e.g. 'worker', 'general', 'explore'). If omitted, defaults to 'worker'.",
  }),
  description: Schema.optionalKey(Schema.String).annotate({
    description: "A short 3-5 word label for the task, displayed to the user",
  }),
  prompt: Schema.optionalKey(Schema.String).annotate({ description: "The task for the subagent to perform" }),
  task: Schema.optionalKey(Schema.String).annotate({
    description: "Alias for prompt: task or instruction for the subagent/worker",
  }),
  instruction: Schema.optionalKey(Schema.String).annotate({
    description: "Alias for prompt: task instruction",
  }),
  query: Schema.optionalKey(Schema.String).annotate({
    description: "Alias for prompt: query or instruction",
  }),
  subagent: Schema.optionalKey(Schema.String).annotate({
    description: "Alias for agent: the subagent or worker name",
  }),
  model: Schema.optionalKey(Schema.String).annotate({
    description:
      'NEVER set this unless the user explicitly asks for a particular model or variant. The value is written as "providerID/modelID", or "providerID/modelID#variant" to include a variant. Do not guess the ID: look the model up with the models tool, filtering to your own provider first.',
  }),
  sessionID: Schema.optionalKey(SessionSchema.ID).annotate({
    description:
      "Continue a specific previous subagent conversation by passing its sessionID. Calls without a sessionID start a new conversation.",
  }),
  background: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "Run the subagent in the background and return immediately. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress.",
  }),
})

export const Output = Schema.Struct({
  sessionID: SessionSchema.ID,
  status: Schema.Literals(["completed", "running"]),
  output: Schema.String,
})
export const description = [
  "Spawns or delegates a task to a specialized worker or subagent (e.g. 'worker', 'general', 'explore') in a child session.",
  "Use this tool to delegate implementation, coding, file exploration, or parallel work to secondary nodes or workers.",
  "The output includes a sessionID you can pass back later to continue that specific conversation with the subagent.",
  "New child sessions start with fresh context, so include all relevant context and instructions when you don't pass a sessionID.",
  "Foreground (default) runs the subagent to completion and returns its final response.",
  "Background mode (background=true) launches it asynchronously and returns immediately; you are notified when it finishes.",
  "Use background only for independent work that can run while you continue elsewhere.",
].join("\n")

export const Plugin = {
  id: "opencode.tool.subagent",
  effect: Effect.fn("SubagentTool.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service
    const jobs = yield* Job.Service
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const permission = yield* Permission.Service
    const models = yield* Model.Service
    const subagents = yield* SubagentJob.Service

    const resolveModel = Effect.fn("SubagentTool.resolveModel")(function* (input: string) {
      const ref = yield* Effect.try({
        try: () => Model.Ref.parse(input),
        catch: () =>
          new ToolFailure({
            message: `Invalid model "${input}". Use "providerID/modelID" or "providerID/modelID#variant".`,
          }),
      })
      const model = (yield* models.available()).find(
        (model) => model.providerID === ref.providerID && model.id === ref.id,
      )
      if (model === undefined)
        return yield* new ToolFailure({
          message: `Model "${ref.providerID}/${ref.id}" is not available. Use the models tool to see what is available.`,
        })
      if (ref.variant !== undefined && !model.variants.some((variant) => variant.id === ref.variant))
        return yield* new ToolFailure({
          message:
            model.variants.length === 0
              ? `Model "${ref.providerID}/${ref.id}" has no variants. Omit the variant.`
              : `Variant "${ref.variant}" is not available for "${ref.providerID}/${ref.id}". Available: ${model.variants.map((variant) => variant.id).join(", ")}.`,
        })
      return ref
    })

    const executor = (input: typeof Input.Type, context: ToolContext) =>
      Effect.gen(function* () {
        const parent = yield* sessions
          .get(context.sessionID)
          .pipe(
            Effect.mapError(
              (error) => new ToolFailure({ message: `Parent session not found: ${context.sessionID}`, error }),
            ),
          )
        let current = parent
        let depth = 0
        while (current.parentID) {
          depth++
          current = yield* sessions
            .get(current.parentID)
            .pipe(
              Effect.mapError(
                (error) => new ToolFailure({ message: `Parent session not found: ${current.parentID}`, error }),
              ),
            )
        }
        const limit = Config.latest(yield* config.entries(), "experimental")?.subagent_depth ?? 1
        if (depth >= limit)
          return yield* new ToolFailure({
            message: `Subagent depth limit reached (${limit}). Increase "experimental.subagent_depth" to allow nested subagents.`,
          })

        const rawPrompt = (
          input.prompt ??
          input.task ??
          input.instruction ??
          input.query ??
          ""
        ).trim()
        if (!rawPrompt) {
          return yield* new ToolFailure({
            message: "Task prompt or instruction is required for subagent delegation.",
          })
        }
        const taskDescription = (
          input.description?.trim() ? input.description : rawPrompt.slice(0, 40)
        ).trim()
        const requestedAgent = input.agent ?? input.subagent ?? "worker"

        let agent = yield* agents.resolve(requestedAgent)
        if (agent === undefined) {
          const allAgents = yield* agents.list()
          const candidate =
            allAgents.find(
              (a) =>
                a.mode !== "primary" &&
                !a.hidden &&
                (a.id === "worker" || a.id.includes("worker") || a.id === "general"),
            ) ?? allAgents.find((a) => a.mode !== "primary" && !a.hidden)
          if (candidate) {
            agent = candidate
          } else {
            return yield* new ToolFailure({ message: `Unknown agent: ${requestedAgent}` })
          }
        }
        if (agent.mode === "primary")
          return yield* new ToolFailure({ message: `Agent ${agent.id} cannot run as a subagent` })
        yield* permission
          .assert({
            action: name,
            resources: [agent.id],
            save: [agent.id],
            sessionID: context.sessionID,
            agent: context.agent,
            source: {
              type: "tool",
              messageID: context.messageID,
              id: context.id,
            },
          })
          .pipe(Effect.mapError((error) => new ToolFailure({ message: `Subagent denied: ${agent.id}`, error })))

        const existing =
          input.sessionID === undefined
            ? undefined
            : yield* sessions
                .get(input.sessionID)
                .pipe(
                  Effect.mapError(
                    (error) =>
                      new ToolFailure({ message: `Subagent session not found: ${input.sessionID}`, error }),
                  ),
                )
        if (existing !== undefined && existing.parentID !== context.sessionID)
          return yield* new ToolFailure({
            message: `Session ${existing.id} is not a child of the current session`,
          })
        const override = input.model === undefined ? undefined : yield* resolveModel(input.model)
        // Continuing with a different agent switches the child, mirroring create semantics
        // where an explicit model wins over the agent's configured model, which wins over the inherited one.
        if (existing !== undefined) {
          const switched = existing.agent !== agent.id
          const model = override ?? (switched ? agent.model : undefined)
          yield* Effect.all([
            switched ? sessions.switchAgent({ sessionID: existing.id, agent: agent.id }) : Effect.void,
            model === undefined ? Effect.void : sessions.switchModel({ sessionID: existing.id, model }),
          ]).pipe(
            Effect.mapError(
              (error) => new ToolFailure({ message: `Failed to switch subagent session: ${existing.id}`, error }),
            ),
          )
        }

        const model = override ?? agent.model ?? parent.model
        const child =
          existing ??
          (yield* sessions
            .create({
              parentID: context.sessionID,
              title: taskDescription,
              agent: Agent.ID.make(agent.id),
              model,
            })
            .pipe(
              Effect.mapError(
                (error) => new ToolFailure({ message: `Parent session not found: ${context.sessionID}`, error }),
              ),
            ))

        const background = input.background === true
        yield* context.progress({ sessionID: child.id, status: "running" })

        // Standard prompt admission outside the job: Job.start joining a running child skips
        // its run effect, and the default wake starts an idle child or steers a running one.
        yield* sessions
          .prompt({
            sessionID: child.id,
            text:
              existing === undefined
                ? ["You are a subagent spawned by another session.", rawPrompt].join("\n")
                : rawPrompt,
            ...(background && existing === undefined ? { resume: false } : {}),
          })
          .pipe(
            Effect.mapError(
              (error) => new ToolFailure({ message: `Failed to prompt subagent: ${child.id}`, error }),
            ),
          )

        const recovery = {
          kind: "subagent" as const,
          parentSessionID: context.sessionID,
          childSessionID: child.id,
          agent: agent.name,
          description: taskDescription,
        }
        yield* subagents.start(recovery)

        if (background) {
          yield* subagents.background(recovery)
          return backgroundResult(child.id)
        }

        const result = yield* jobs.block({ id: child.id, sessionID: context.sessionID }).pipe(
          Effect.onInterrupt(() =>
            Effect.all([sessions.interrupt(child.id), jobs.cancel(child.id)], {
              discard: true,
            }),
          ),
        )
        if (result?.type === "backgrounded") {
          yield* subagents.notify(recovery, result.info.started_at)
          return backgroundResult(child.id)
        }
        // Failure surfaces keep the sessionID visible so the model can continue the child.
        if (result?.info.status === "error")
          return yield* new ToolFailure({
            message: `Subagent failed (sessionID: ${child.id}): ${result.info.error ?? "unknown error"}`,
          })
        if (result?.info.status === "cancelled")
          return yield* new ToolFailure({ message: `Subagent cancelled (sessionID: ${child.id})` })
        return {
          sessionID: child.id,
          status: "completed" as const,
          output: result?.info.output ?? SubagentCompletion.NO_TEXT,
        }
      }).pipe(
        Effect.map((output) => ({
          output,
          content:
            output.status === "completed"
              ? `<subagent sessionID="${output.sessionID}" state="completed">\n${output.output}\n</subagent>`
              : output.output,
          metadata: { sessionID: output.sessionID, status: output.status },
        })),
      )

    const toolOptions = { direct: true, pinned: true }

    yield* ctx.tool
      .transform((editor) => {
        editor.add({
          name: "subagent",
          options: toolOptions,
          description,
          input: Input,
          output: Output,
          execute: executor,
        })
        editor.add({
          name: "delegate_task",
          options: toolOptions,
          description: [
            "Delegates a task to a specialized subagent or worker agent (e.g. 'worker', 'general', 'explore').",
            "Use this tool to delegate work to secondary worker nodes or subagents.",
            description,
          ].join("\n"),
          input: Input,
          output: Output,
          execute: executor,
        })
        editor.add({
          name: "delegate",
          options: toolOptions,
          description: [
            "Alias for delegate_task/subagent. Delegates a task to a specialized worker or subagent.",
            description,
          ].join("\n"),
          input: Input,
          output: Output,
          execute: executor,
        })
      })
      .pipe(Effect.orDie)

    yield* ctx.tool.hook("execute.before", (event) =>
      Effect.sync(() => {
        if (!["subagent", "delegate_task", "delegate"].includes(event.tool) || !Predicate.isObject(event.input)) return
        if (event.input.model !== "" && event.input.sessionID !== "") return
        const input = { ...event.input }
        if (input.model === "") delete input.model
        if (input.sessionID === "") delete input.sessionID
        if (!input.prompt && (input.task || input.instruction || input.query)) {
          input.prompt = input.task ?? input.instruction ?? input.query
        }
        if (!input.description && input.prompt) {
          input.description = String(input.prompt).slice(0, 40)
        }
        if (!input.agent && input.subagent) {
          input.agent = input.subagent
        }
        event.input = input
      }),
    )

    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        const toolNames = ["subagent", "delegate_task", "delegate"]
        for (const toolName of toolNames) {
          const tool = event.tools[toolName]
          if (!tool) continue
          const selected = yield* agents.resolve(event.agent)
          if (!selected) continue
          const available = (yield* agents.list())
            .filter(
              (agent) =>
                agent.mode !== "primary" &&
                !agent.hidden &&
                Permission.evaluate(name, agent.id, selected.permissions).effect !== "deny",
            )
            .toSorted((a, b) => a.id.localeCompare(b.id))
          if (available.length === 0) continue
          tool.description = [
            tool.description,
            "",
            "Available subagents / workers:",
            ...available.map(
              (agent) =>
                `- ${agent.id}: ${agent.description ?? "This worker agent can be called to execute tasks."}`,
            ),
          ].join("\n")
        }
      })
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
}
