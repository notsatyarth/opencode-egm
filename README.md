# opencode-egm

[Elephant-Goldfish Model](https://egm.dev) for **OpenCode v2**.
Design with an elephant (your main agent), review with goldfish (zero-context subagents).

## Install
```jsonc
// opencode.jsonc
{ "plugins": ["github:notsatyarth/opencode-egm"] }
```
or `opencode plugin add github:notsatyarth/opencode-egm`.

## What you get
- Skills: `egm-brainstorm`, `egm-draft`, `egm-review`, `egm-resolve`, `egm-bootstrap`, `egm-review-loop`, `egm-drift-report` (upstream, unmodified, in `content/`).
- Slash commands with the same names.
- Tool `egm_goldfish(persona, task)`: spawns a **fresh child session** per call, read-only permissions
  (no edit/shell, `.env` blocked), seeded with only the persona prompt + your task, deleted afterwards.
  Parallel calls give a swarm. This enforces the Goldfish isolation invariant in code.

## Design notes
- v2 plugin API cannot register new agents (agent editor has only update/remove/default), so personas are
  injected as prompts into isolated sessions instead of named subagents. Reviewer runs on the built-in `explore` agent.
- Status: **experimental. Typechecks, but plugin loading and the goldfish tool are NOT yet verified on OpenCode 2.0.28** (a local load test did not register it; cause unknown). Session-transcript extraction is defensive;
  check `egm_goldfish` output first.
- Update upstream content: re-copy `skills/`, `agents/`, `resources/` from the upstream repo.
