import { Plugin } from "@opencode/plugin"
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "content")
const SKILLS = join(ROOT, "skills")
const AGENTS = join(ROOT, "agents")

/** Split YAML-ish frontmatter from body (only flat `key: value` needed). */
function parse(file: string) {
  const raw = readFileSync(file, "utf8")
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  const meta: Record<string, string> = {}
  if (m) {
    let key = ""
    for (const line of m[1].split("\n")) {
      const kv = line.match(/^([\w-]+):\s*(.*)$/)
      if (kv) { key = kv[1]; meta[key] = kv[2].replace(/^>-?$/, "").trim() }
      else if (key && /^\s+/.test(line)) meta[key] = (meta[key] + " " + line.trim()).trim()
    }
  }
  return { meta, body: m ? m[2] : raw }
}

const personas = () =>
  readdirSync(AGENTS).filter((f) => f.endsWith(".md")).map((f) => {
    const { meta, body } = parse(join(AGENTS, f))
    return { name: meta.name, description: meta.description ?? "", body, file: join(AGENTS, f) }
  })

const READ_ONLY = [
  { action: "*", resource: "*", effect: "deny" as const },
  { action: "read", resource: "*", effect: "allow" as const },
  { action: "read", resource: "*.env", effect: "deny" as const },
  { action: "read", resource: "*.env.*", effect: "deny" as const },
  { action: "glob", resource: "*", effect: "allow" as const },
  { action: "grep", resource: "*", effect: "allow" as const },
  { action: "external_directory", resource: `${ROOT}/**`, effect: "allow" as const },
]

/** Pull assistant text out of a session transcript without depending on its exact shape. */
function lastAssistantText(messages: readonly any[]): string {
  const texts = (m: any): string[] => {
    const out: string[] = []
    const walk = (v: any) => {
      if (!v) return
      if (Array.isArray(v)) return v.forEach(walk)
      if (typeof v === "object") {
        if (v.type === "text" && typeof v.text === "string") out.push(v.text)
        else if (Array.isArray(v.content)) walk(v.content)
        else if (Array.isArray(v.parts)) walk(v.parts)
      }
    }
    walk(m.content ?? m.parts ?? m)
    return out
  }
  for (const m of [...messages].reverse()) {
    if (m.type === "assistant" || m.role === "assistant") {
      const t = texts(m).join("\n").trim()
      if (t) return t
    }
  }
  return ""
}

export default Plugin.define({
  id: "egm",
  async setup(ctx) {
    const roster = personas()

    // 1. Skills: the seven upstream EGM skills, loaded from the bundled content.
    const skillDirs = readdirSync(SKILLS).filter((d) => existsSync(join(SKILLS, d, "SKILL.md")))
    await ctx.skill.transform((editor) => {
      for (const id of skillDirs) {
        const path = join(SKILLS, id, "SKILL.md")
        const { meta, body } = parse(path)
        const preamble =
          `EGM bundle root: ${ROOT}\n` +
          `Resolve \`agents/\`, \`resources/\` against that root and \`references/\` against ${join(SKILLS, id)}.\n` +
          `Where the skill says to spawn a Goldfish/subagent, call the \`egm_goldfish\` tool ` +
          `(persona = the agent's frontmatter name, e.g. egm-zoom-out). Never review in your own context.\n\n`
        editor.add({
          id: id as any, name: (meta.name ?? id) as any,
          description: meta.description, autoinvoke: false,
          path: path as any, content: preamble + body,
        } as any)
      }
    })

    // 2. Slash commands: /egm-brainstorm, /egm-draft, ...
    await ctx.command.transform((editor) => {
      for (const id of skillDirs) {
        editor.add({
          name: id,
          description: parse(join(SKILLS, id, "SKILL.md")).meta.description?.slice(0, 120),
          execute: async ({ sessionID, prompt, delivery }) => {
            await ctx.session.prompt({
              ...prompt, sessionID, delivery,
              text: `Load the \`${id}\` skill with the skill tool and follow it exactly.\n\nUser request: ${prompt.text}`,
            } as any)
          },
        })
      }
    })

    // 3. Goldfish tool: each call = brand-new child session, read-only, persona + task only.
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "egm_goldfish",
        description:
          "Run ONE zero-context EGM Goldfish reviewer in a fresh, read-only session. " +
          "It sees only the persona and your task text (no conversation history). Personas: " +
          roster.map((p) => p.name).join(", ") + ". Call several in parallel for a swarm.",
        input: {
          type: "object",
          properties: {
            persona: { type: "string", enum: roster.map((p) => p.name) },
            task: { type: "string", description: "Self-contained task: Mode, absolute target paths, standards, reading list. No chat history." },
          },
          required: ["persona", "task"],
          additionalProperties: false,
        },
        execute: async (input: any, context: any) => {
          const p = roster.find((r) => r.name === input.persona)
          if (!p) throw new Error(`Unknown persona ${input.persona}`)
          const child = await ctx.session.create({ title: `goldfish: ${p.name}` } as any)
          const sessionID = (child as any).id ?? (child as any).sessionID
          try {
            await ctx.session.switchAgent({ sessionID, agent: "explore" } as any)
            await ctx.session.update({ sessionID, permissions: READ_ONLY } as any)
            const onAbort = () => void ctx.session.interrupt({ sessionID, resume: false } as any)
            context.signal?.addEventListener("abort", onAbort, { once: true })
            await ctx.session.prompt({
              sessionID,
              text: `${p.body}\n\n---\n# Task\n${input.task}\n\nReturn your findings as your final message. Do not write files.`,
            } as any)
            await ctx.session.wait({ sessionID } as any)
            const report = lastAssistantText(await ctx.session.context({ sessionID } as any))
            return { content: report || "Goldfish returned no report (treat review as incomplete)." } as any
          } finally {
            await ctx.session.remove({ sessionID } as any).catch(() => {})
          }
        },
      } as any)
    })
  },
})
