# AGENTS.md — fleets

This repo is one tool: `fleet.ts`, a single-file CLI for running a fleet
of coding agents with shared, durable memory. It is a port of the memory
idea in UniiChat (github.com/VictorTaelin/UniiChat): one never-ending
global chat per project, compressed into a binary summary tree, plus one
thread per agent. There are no dependencies, no build step, and no
server. The CLI never calls a model; the LLM is the manager agent
running it (see "Compaction" below).

This repo is also a portable [Agent Skill](https://agentskills.io):
`SKILL.md` at the root carries the spec frontmatter (`name`,
`description`, `compatibility`, `metadata`) plus the condensed
workflows an agent follows when the skill is active. This file is the
full reference behind it; `README.md` is the human-facing overview.

## Runtime

- **Node.js 22+ is the default.** The shebang is `#!/usr/bin/env node`,
  so `./fleet.ts ...` runs under Node. The file uses only `node:*`
  imports and erasable TypeScript, so Node's type stripping runs it
  directly with no build step.
- **Bun also works** (`bun fleet.ts ...`) if the user says they prefer
  Bun. No Bun-specific APIs are used, and both runtimes are tested.
- Run it from anywhere; the examples below assume your working directory
  is this repo, or use an absolute path to `fleet.ts`.

## Concepts

- **Project.** One unit of work, e.g. `demo`. A project is a directory
  holding one global chat. Create it with `fleet init`.
- **Global chat.** The project's append-only log. Every message has a
  kind: `user`, `manager`, `work` (an agent's report), `unii`, `tool`,
  `echo`, `note`. Nothing is ever deleted or rewritten.
- **Summary tree.** Message `i` is compressed into a node `(0,i)` of at
  most 512 bytes. Node `(l,i)` merges its two children. A node whose
  source already fits is its own node and needs no model.
- **View.** What a call reads: a list of nodes covering the chat to its
  end, oldest first. Recent messages appear one line each; older ones
  are covered by fewer, broader lines. Detail fades with age, but
  nothing is lost: any line can be opened.
- **Refs.** Nodes are addressed as `id+n`: the `n` messages from `id`
  on. `0+1` is message 0; `0+4` covers messages 0–3. `n` is always a
  power of 2 and `id` a multiple of `n`.
- **Agent thread.** One log per agent (`agents/<Name>.jsonl`) plus one
  work dir (`work/<Name>/`). An agent's full thread is its context; it
  can resume from its log after a restart.
- **Task.** One row in `tasks.json` per agent: its task text, branch,
  and status (`working`, `idle`, `done`, `blocked`).

## Layout

```
fleets/
  fleet.ts      the CLI (this repo's whole tool)
  AGENTS.md     this file
  <project>/    runtime state, created by `fleet init` (not repo content)
    main/                 messages, JSON lines, one file per day
    tree/                 summary nodes, JSON lines, one file per day
    main.index            binary index: 16 bytes per message slot
    tree.index            binary index: 16 bytes per tree slot
    view.json             materialized view + pick/goal/work
    agents/<Name>.jsonl   one log per agent thread
    tasks.json            task queue: owner, branch, status
    work/<Name>/          working dir per agent
```

Project directories are per-machine runtime state. Do not commit them
to git, and do not hand-edit anything inside them: always go through
the CLI. The CLI repairs a crash-truncated last line on load.

Where projects live: `--root <dir>` wins, else `$FLEET_ROOT`, else the
directory holding `fleet.ts`. So by default a project created next to
this repo's `fleet.ts` lands in `fleets/<project>/`.

## When to use it

Use the fleet CLI when:

- Two or more agents work on shared work and need one source of truth.
- The history must survive across sessions, restarts, or days.
- A manager needs to see progress and reports on demand.

Do not use it for a one-off single-agent task. Just do the work; the
CLI earns its keep when there is a fleet to coordinate or a history
worth keeping.

## Commands

Run `fleet help` for the full list. Text for any command can come from
`--text` / `--message` / `--task`, trailing words, `--file`, or stdin.
Add `--json` for machine-readable output.

| Command | When to use it |
|---|---|
| `fleet init <project>` | Once, to create a project. Refuses if it exists. |
| `fleet log <project> --kind <k> --text <t>` | Append to the global chat: plans, decisions, user messages, findings. Say in your message what will matter later; summaries keep little tool output. |
| `fleet view <project>` | Read the compressed whole-chat view before acting. This is the first thing to read when joining a project. |
| `fleet zoom <project> <id+n\|id\|Name>` | Drill down: open a summary line into its two children, read one message whole (`n = 1`), or read an agent's whole thread (by name). Zoom is the way to navigate history; never grep the log files. |
| `fleet spawn <project> --task <t> [--name N] [--branch B]` | Start one agent thread per task, in parallel. Returns the agent's name at once. One agent owns one task and one branch. |
| `fleet tell <project> <name> --message <m>` | Send a message to an agent thread: a follow-up, a correction, new information. |
| `fleet report <project> <name> --text <t> [--done]` | Inject an agent's report into the global chat as a `[Name]` work message. Use `--done` when the task is finished. |
| `fleet status <project>` | The manager's dashboard: message count, view size, tree build state, nodes waiting on the LLM, agents, tasks, recent lines. |
| `fleet agents <project>` | List agent threads with log lengths and status. |
| `fleet tasks <project>` | List tasks and their status. |
| `fleet compact <project>` | After logging a batch of work. Builds nodes whose source fits; if more need the LLM, logs one request note for the manager (see "Compaction"). |
| `fleet ready <project> [--one <id+n>]` | List nodes waiting on LLM compaction. `--one` prints one node's full compaction task. For compactor agents. |
| `fleet store-node <project> <id+n> --text <line>` | Store one LLM-written summary line (at most 512 bytes). For compactor agents. |
| `fleet tree <project>` | Print the view, then the tree level by level. For debugging the tree. |

## Workflows

### Manager loop

You (the manager) own the project. Your loop:

1. `fleet init <project>` once; `fleet log` the plan and decisions.
2. Split the work and `fleet spawn` one agent per task, each with its
   own branch.
3. Check in with `fleet status` and `fleet view`. Read agent reports
   as they land in the global chat; send follow-ups with `fleet tell`.
4. After a batch of activity, run `fleet compact`. If it logs a
   compaction request, spawn a compactor agent (below).
5. When all tasks report `--done` and `fleet compact` reports no nodes
   need the LLM, the project is clean.

### Worker agent loop

A spawned agent's loop:

1. Read your task from your thread: `fleet zoom <project> <YourName>`.
2. Read project context with `fleet view <project>`, zooming into
   anything your task depends on before acting.
3. Do the work in your own directory, `work/<YourName>/`, on your own
   branch. Do not touch another agent's work dir or thread.
4. When finished (or blocked), `fleet report <project> <YourName>
   --text <report> [--done]`. The report is your final word: what you
   did, what you found, what failed. The manager reads it as a `work`
   message in the global chat.

### Compaction loop

The CLI never writes summaries itself and never calls a model. The
LLM (you, the manager, or a compactor agent you spawn) writes every
summary line. The loop:

1. `fleet compact <project>` builds every node whose source already
   fits in 512 bytes. For the rest, it logs exactly one note into the
   global chat: `compaction needed: N node(s)...`, listing the refs.
   Repeated runs do not log again while that note is the last message.
2. The manager spawns a compactor agent for the queued refs, e.g.
   `fleet spawn <project> --task "Compact ready nodes: run fleet ready
   <project> --one <id+n>, write a <=512 byte line, store it with fleet
   store-node, repeat until the queue is empty, then report."`
3. The compactor agent reads one task with
   `fleet ready <project> --one <id+n>`. The output is the full
   compaction prompt: the ruler, the rules, recent view context, and
   the source to compress.
4. The agent writes one line and stores it:
   `fleet store-node <project> <id+n> --text <line>`. The CLI
   validates it: the node must exist and be ready, its halves must be
   built, and the line must be non-empty and at most 512 bytes.
   Storing a node can unblock its parent, which may then fit (built
   automatically) or need the LLM in turn.
5. The agent repeats steps 3–4 until `fleet ready` is empty, then
   reports back with `fleet report ... --done`. The manager re-runs
   `fleet compact` to confirm the tree is clean.

Writing a good summary line (from the compaction prompt):

- Output only the line, without an `id+n|` head. One line: no newlines.
- Keep user words closest to verbatim; then lasting effects and
  failures; then findings; least of all tool steps.
- Copy names, numbers, ids, paths, and errors exactly.
- Never make anything look further along than it was. Name a minor
  item in a word or two rather than dropping it: an absent item can
  never be found again.
- If the CLI says the line is over the limit, rewrite it shorter. Do
  not clip it: there is no truncation path, by design.

## Rules

- **Never hand-edit** `main/`, `tree/`, `*.index`, `view.json`,
  `agents/*.jsonl`, or `tasks.json`. The CLI owns those files; every
  write goes through a command.
- **Never grep the logs for history.** Read `fleet view`, then
  `fleet zoom` to the detail you need.
- **Append-only.** Messages and nodes are never edited or deleted.
  Correct a mistake with a new message, not by rewriting history.
- **One agent, one task, one branch.** Agents write only to their own
  thread and work dir, and report through `fleet report`.
- **Reports are the interface.** The manager learns what an agent did
  only from its `work` message in the global chat. A finished task
  without a report is unfinished.
- **No truncation, no model calls in the CLI.** If a summary line does
  not fit, rewrite it. If a node needs intelligence, it waits for the
  LLM loop. Do not add a truncation fallback or a model API call to
  `fleet.ts`.
- **Keep `fleet.ts` a single file.** No dependencies, no build step,
  no imports beyond `node:*`. It must keep running under both Node 22+
  and Bun.

## Example session

```
node fleet.ts init demo
node fleet.ts log demo --kind user --text "Ship the login fix today"
node fleet.ts log demo --kind manager --text "Plan: fix redirect, add test, update docs"
node fleet.ts spawn demo --task "Fix login redirect to /dashboard" --branch fix/login --name RedFox
node fleet.ts spawn demo --task "Check password reset flow end to end" --name CalmOwl
node fleet.ts status demo
node fleet.ts view demo
node fleet.ts report demo RedFox --text "Fixed redirect, added test, all green." --done
node fleet.ts compact demo
node fleet.ts ready demo --one 6+1
node fleet.ts store-node demo 6+1 --text "user: password reset emails carry a token expiring after one hour."
node fleet.ts compact demo
```
