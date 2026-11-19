---
name: fleets
description: >-
  Coordinate a fleet of coding agents with shared, durable memory using
  the fleet.ts CLI: one never-ending global chat per project, a binary
  summary tree with view and zoom for navigating history, one thread and
  work directory per agent, and LLM-in-the-loop compaction. Use when two
  or more agents work on shared tasks, when project history must survive
  across sessions, or when a manager needs progress reports on demand.
compatibility: Requires Node.js 22+ (or Bun) to run fleet.ts. No dependencies, no build step, no network access.
metadata:
  version: "0.2.2"
  author: jacob-test-profile
---

# Fleets

Coordinate a fleet of coding agents with shared, durable memory. One
never-ending global chat per project, compressed into a binary summary
tree, plus one thread per agent. The tool is `fleet.ts`, a single-file
CLI in this skill's directory. It never calls a model: you are the LLM,
and compaction is LLM-in-the-loop (see "Compaction" below).

## When to use this skill

Use it when two or more agents work on shared tasks and need one source
of truth, when project history must survive across sessions and
restarts, or when a manager needs to see progress and reports on
demand. Do not use it for a one-off single-agent task; just do the
work.

## Running the CLI

The CLI is `fleet.ts` at this skill's root. Run it from that directory:

```
node fleet.ts help
./fleet.ts status demo
```

Node.js 22+ is the default (the shebang is `#!/usr/bin/env node`). Bun
also works (`bun fleet.ts ...`) if the user prefers it. There are no
dependencies and no build step. All commands take `--json` for
machine-readable output, and text can come from `--text` / `--message`
/ `--task`, trailing words, `--file`, or stdin.

Projects live in a root directory: `--root <dir>` wins, else
`$FLEET_ROOT`, else the directory holding `fleet.ts`. Each project is
one directory holding the global chat, the tree, agent threads, tasks,
and work dirs.

## Concepts

- **Project.** One unit of work, created with `fleet.ts init`.
  Everything about it lives in one directory.
- **Global chat.** The project's append-only log. Message kinds:
  `user`, `manager`, `work` (an agent's report), `unii`, `tool`,
  `echo`, `note`. Nothing is ever deleted or rewritten.
- **Summary tree.** Message `i` is compressed into a node `(0,i)` of
  at most 512 bytes. Node `(l,i)` merges its two children. A node whose
  source already fits is its own node and needs no model.
- **View.** What you read: nodes covering the chat to its end, oldest
  first. Recent messages appear one line each; older ones are covered
  by fewer, broader lines. Detail fades with age, but nothing is lost:
  any line can be opened.
- **Refs.** Nodes are addressed as `id+n`: the `n` messages from `id`
  on. `0+1` is message 0; `0+4` covers messages 0-3. `n` is always a
  power of 2 and `id` a multiple of `n`.
- **Agent thread.** One log per agent plus one work directory. An
  agent's full thread is its context; it can resume from its log after
  a restart.
- **Task.** One row per agent: its task text, branch, and status
  (`working`, `idle`, `done`, `blocked`).

## Manager loop

You (the manager) own the project:

1. `fleet.ts init <project>` once; `fleet.ts log` the plan and
   decisions.
2. Split the work and `fleet.ts spawn` one agent per task, each with
   its own branch. `spawn` returns the agent's name at once.
3. Check in with `fleet.ts status` and `fleet.ts view`. Read agent
   reports as they land in the global chat; send follow-ups with
   `fleet.ts tell`.
4. After a batch of activity, run `fleet.ts compact`. If it logs a
   compaction request, spawn a compactor agent (below).
5. When all tasks report `--done` and `fleet.ts compact` reports no
   nodes need the LLM, the project is clean.

## Worker agent loop

A spawned agent's loop:

1. Read your task from your thread: `fleet.ts zoom <project>
   <YourName>`.
2. Read project context with `fleet.ts view <project>`, zooming into
   anything your task depends on before acting.
3. Do the work in your own directory, `work/<YourName>/`, on your own
   branch. Do not touch another agent's work dir or thread.
4. When finished (or blocked), `fleet.ts report <project> <YourName>
   --text <report> [--done]`. The report is your final word: what you
   did, what you found, what failed. The manager reads it as a `work`
   message in the global chat.

## Compaction loop

The CLI never writes summaries itself and never calls a model. The LLM
(you, or a compactor agent you spawn) writes every summary line:

1. `fleet.ts compact <project>` builds every node whose source already
   fits in 512 bytes. For the rest, it logs exactly one note into the
   global chat: `compaction needed: N node(s)...`, listing the refs.
   Repeated runs do not log again while that note is the last message.
2. The manager spawns a compactor agent for the queued refs.
3. The compactor reads one task with `fleet.ts ready <project> --one
   <id+n>`. The output is the full compaction prompt: the ruler, the
   rules, recent view context, and the source to compress.
4. The agent writes one line and stores it: `fleet.ts store-node
   <project> <id+n> --text <line>`. The CLI validates it: the node must
   exist and be ready, its halves must be built, and the line must be
   non-empty and at most 512 bytes. Storing a node can unblock its
   parent, which may then fit (built automatically) or need the LLM in
   turn.
5. The agent repeats steps 3-4 until `fleet.ts ready` is empty, then
   reports back with `fleet.ts report ... --done`. The manager re-runs
   `fleet.ts compact` to confirm the tree is clean.

Writing a good summary line: output only the line, without an `id+n|`
head. One line: no newlines. Keep user words closest to verbatim; then
lasting effects and failures; then findings; least of all tool steps.
Copy names, numbers, ids, paths, and errors exactly. Never make
anything look further along than it was. Name a minor item in a word or
two rather than dropping it: an absent item can never be found again.
If the CLI says the line is over the limit, rewrite it shorter. Do not
clip it: there is no truncation path, by design.

## Commands

| Command | When to use it |
|---|---|
| `fleet.ts init <project>` | Once, to create a project. |
| `fleet.ts log <project> --kind <k> --text <t>` | Append to the global chat: plans, decisions, user messages, findings. |
| `fleet.ts view <project>` | Read the compressed whole-chat view before acting. Read this first when joining a project. |
| `fleet.ts zoom <project> <id+n\|id\|Name>` | Drill down: open a summary line into its children, read one message whole, or read an agent's whole thread by name. |
| `fleet.ts spawn <project> --task <t> [--name N] [--branch B]` | Start one agent thread per task, in parallel. |
| `fleet.ts tell <project> <name> --message <m>` | Send a message to an agent thread. |
| `fleet.ts report <project> <name> --text <t> [--done]` | Inject an agent's report into the global chat as a `[Name]` work message. |
| `fleet.ts status <project>` | The manager's dashboard: messages, view size, tree state, nodes waiting on the LLM, agents, tasks, recent lines. |
| `fleet.ts agents <project>` | List agent threads with log lengths and status. |
| `fleet.ts tasks <project>` | List tasks and their status. |
| `fleet.ts compact <project>` | After logging a batch of work. Builds nodes whose source fits; if more need the LLM, logs one request note. |
| `fleet.ts ready <project> [--one <id+n>]` | List nodes waiting on LLM compaction. `--one` prints one node's full task. |
| `fleet.ts store-node <project> <id+n> --text <line>` | Store one LLM-written summary line (at most 512 bytes). |
| `fleet.ts tree <project>` | Print the view, then the tree level by level. For debugging the tree. |

## Rules

- Never hand-edit `main/`, `tree/`, `*.index`, `view.json`,
  `agents/*.jsonl`, or `tasks.json`. Every write goes through the CLI.
- Never grep the logs for history. Read `fleet.ts view`, then
  `fleet.ts zoom` to the detail you need.
- Append-only. Correct a mistake with a new message, not by rewriting
  history.
- One agent, one task, one branch. Agents write only to their own
  thread and work dir, and report through `fleet.ts report`.
- Reports are the interface. A finished task without a report is
  unfinished.
- No truncation, no model calls in the CLI. If a summary line does not
  fit, rewrite it. If a node needs intelligence, it waits for the LLM
  loop.
- Keep `fleet.ts` a single file. No dependencies, no build step, no
  imports beyond `node:*`. It must keep running under both Node 22+
  and Bun.

## Full reference

`AGENTS.md` in this directory is the full reference: the same
workflows in more detail, the project layout, and the example session.
Read it when you need more than this file.
