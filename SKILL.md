---
name: fleets
description: >-
  Coordinate a fleet of coding agents with shared, durable memory using
  the fleet.ts CLI: one never-ending global chat per project, a binary
  summary tree with view and zoom for navigating history, one thread and
  work directory per agent, and scheduled out-of-band compaction. Use when two
  or more agents work on shared tasks, when project history must survive
  across sessions, or when a manager needs progress reports on demand.
compatibility: Requires Node.js 22+ (or Bun) to run fleet.ts. No dependencies, no build step, no network access.
metadata:
  version: "0.3.0"
  author: jacob-test-profile
---

# Fleets

Coordinate a fleet of coding agents with shared, durable memory. One
never-ending global chat per project, compressed into a binary summary
tree, plus one thread per agent. The tool is `fleet.ts`, a single-file
CLI in this skill's directory. It never calls a model: compaction runs
out of band, on a schedule (see "Scheduled compaction" below).

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
   decisions. Set up the generic scheduled compaction task yourself
   (see "Scheduled compaction" below) — once, not per project.
2. Split the work and `fleet.ts spawn` one agent per task, each with
   its own branch. `spawn` returns the agent's name at once. When the
   work is in a git repo, give each agent its own git worktree before
   it starts: `git worktree add <path> <branch>` (one per agent; the
   manager's checkout stays on the main branch). All agents share one
   filesystem, so a shared working directory means branch switches and
   stray files collide — a worktree per agent is what makes "one
   agent, one branch" real.
3. Check in with `fleet.ts status` and `fleet.ts view`. Read agent
   reports as they land in the global chat; send follow-ups with
   `fleet.ts tell`.
4. After a batch of activity, run `fleet.ts compact`. It builds what
   fits and logs the rest to the compaction queue; the scheduled
   compactor drains it out of band. Never spawn a compactor inline.
5. When all tasks report `--done` and `fleet.ts status` shows the
   compaction queue empty, the project is clean.

## Worker agent loop

A spawned agent's loop:

1. Read your task from your thread: `fleet.ts zoom <project>
   <YourName>`.
2. Read project context with `fleet.ts view <project>`, zooming into
   anything your task depends on before acting.
3. Do the work in your own directory, `work/<YourName>/`, on your own
   branch. Do not touch another agent's work dir or thread. When the
   project is a git repo, your directory is a git worktree on your
   branch — never check out another branch there, and never work in
   the manager's checkout.
4. When finished (or blocked), `fleet.ts report <project> <YourName>
   --text <report> [--done]`. The report is your final word: what you
   did, what you found, what failed. The manager reads it as a `work`
   message in the global chat.

## Scheduled compaction

Compaction runs out of band, on a schedule — never in the manager's
loop. The CLI never writes summaries itself and never calls a model.
The LLM (your scheduled compactor task) writes every summary line.

### Setting it up (do this yourself)

You configure the scheduled task — the user does not. Do it once,
when you first adopt this skill or create your first project:

1. Find your environment's recurring-task mechanism, in this order:
   - A heartbeat or recurring-checklist file your environment reads
     on every tick (e.g. a `HEARTBEAT.md` checklist): add the drain
     as one line. This is the preferred home — it reuses a loop that
     already runs.
   - A scheduled-task or cron API: create one generic recurring task,
     every 30 minutes, with the task text below.
   - Any other recurring agent-task feature your platform offers.
2. Check for an existing compaction task first. If one already runs —
   standalone or inside a heartbeat — reuse it: retime it to every 30
   minutes if needed, but never run two compaction tasks; they would
   race on the same queue. If you move compaction into a heartbeat,
   remove the standalone task it replaces.
3. Install the drain with the task text below. It covers every open
   project, so new projects need no new setup.
4. Verify the setup: confirm the schedule exists and note its next
   run. A schedule you cannot see is not set up.

How it works:

1. `fleet.ts compact <project>` builds every node whose source already
   fits in 512 bytes, and logs the rest to `compaction-queue.json` in
   the project directory: the pending refs, their levels, and sizes,
   with a timestamp. It logs nothing into the global chat, and the
   manager does nothing further.
2. One generic scheduled task — the one you set up above — runs every
   30 minutes and drains the queue for every open project it finds (a
   subdirectory holding a fleet project). The task runs on its own;
   the manager never blocks on compaction and never spawns a compactor
   inline. New projects are covered automatically.
3. Each run of the scheduled task, for each open project in turn:
   - Run `fleet.ts compact <project>` to refresh the queue.
   - While `fleet.ts ready <project>` lists nodes, take one with
     `fleet.ts ready <project> --one <id+n>`. The output is the full
     compaction prompt: the ruler, the rules, recent view context, and
     the source to compress.
   - Write one line and store it: `fleet.ts store-node <project>
     <id+n> --text <line>`. The CLI validates it: the node must exist
     and be ready, its halves must be built, and the line must be
     non-empty and at most 512 bytes. Storing a node can unblock its
     parent, which may then fit (built automatically) or need the LLM
     in turn. Each store refreshes `compaction-queue.json`.
   - Repeat until `fleet.ts ready` is empty, then run `fleet.ts
     compact <project>` once more to confirm the tree is clean and log
     the empty queue.
   - If the queue is empty, exit quietly: no report, no message in
     the global chat. Compaction leaves no trace in the chat.
4. `fleet.ts status <project>` shows the queue state: how many nodes
   are waiting and when the queue was last logged.

Task text to schedule (one generic task, every 30 minutes, over all open projects):

> Drain the fleet compaction queues for every open fleet project: for
> each project in turn, run `fleet.ts compact <project>`, then while
> `fleet.ts ready <project>` lists nodes, compact each with
> `fleet.ts ready <project> --one <id+n>` and `fleet.ts store-node
> <project> <id+n> --text <line>` (one line, at most 512 bytes), until
> `fleet.ts ready` is empty. Finish with `fleet.ts compact <project>`
> to confirm. If nothing is pending, exit quietly.

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
| `fleet.ts compact <project>` | After logging a batch of work. Builds nodes whose source fits; logs the rest to the compaction queue for the scheduled compactor. |
| `fleet.ts ready <project> [--one <id+n>]` | List nodes waiting on scheduled compaction. `--one` prints one node's full task. |
| `fleet.ts store-node <project> <id+n> --text <line>` | Store one LLM-written summary line (at most 512 bytes). For the scheduled compactor. |
| `fleet.ts tree <project>` | Print the view, then the tree level by level. For debugging the tree. |

## Rules

- Never hand-edit `main/`, `tree/`, `*.index`, `view.json`,
  `compaction-queue.json`, `agents/*.jsonl`, or `tasks.json`. Every
  write goes through the CLI.
- Never grep the logs for history. Read `fleet.ts view`, then
  `fleet.ts zoom` to the detail you need.
- Append-only. Correct a mistake with a new message, not by rewriting
  history.
- One agent, one task, one branch, one worktree. Agents write only to
  their own thread and work dir, and report through `fleet.ts report`.
  When the work is in a git repo, each agent gets its own git worktree
  (`git worktree add <path> <branch>`) before it starts; the manager's
  checkout stays on the main branch.
- Reports are the interface. A finished task without a report is
  unfinished.
- No truncation, no model calls in the CLI. If a summary line does not
  fit, rewrite it. If a node needs intelligence, it waits for the
  scheduled compactor.
- Compaction is out of band. Never spawn a compactor agent from the
  manager loop; the scheduled task drains the queues every 30 minutes, for
  every open project. Set that task up yourself when you adopt the skill;
  never ask the user to schedule compaction.
- Keep `fleet.ts` a single file. No dependencies, no build step, no
  imports beyond `node:*`. It must keep running under both Node 22+
  and Bun.

## Full reference

`AGENTS.md` in this directory is the full reference: the same
workflows in more detail, the project layout, and the example session.
Read it when you need more than this file.
