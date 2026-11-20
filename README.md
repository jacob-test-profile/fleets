# fleets

A single-file CLI for running a fleet of coding agents with shared,
durable memory. One never-ending chat per project, compressed into a
summary tree, plus one thread per agent, so a manager can see progress
and reports on demand and history survives across sessions.

## Why

One agent can keep its own context. A fleet cannot: several agents
working in parallel need one source of truth for the plan, the
decisions, and what each of them has done. `fleets` is that source of
truth. It is a port of the memory idea in
[UniiChat](https://github.com/VictorTaelin/UniiChat): an append-only
chat, a binary summary tree over it, and a view that keeps recent
messages at full detail and older ones in broader merged lines, so the
whole history stays readable at any size.

The CLI never calls a model. When a summary needs real compression, it
logs the node to the compaction queue, and one generic scheduled compactor
task writes the lines out of band, every hour, for every open project.
There is no truncation fallback: a line either fits in 512 bytes or gets
rewritten by the LLM.

## Requirements

- Node.js 22+ (default) or Bun. No dependencies, no build step, no
  install, no network access.

## Install

Clone the repo:

```
git clone https://github.com/jacob-test-profile/fleets.git
cd fleets
./fleet.ts help
```

### As an agent skill

This repo is also an [Agent Skill](https://agentskills.io)
(`SKILL.md` at the root), so any compatible agent can install it by
copying or symlinking the directory into its skills folder, for
example:

```
# Claude Code (user skills)
cp -r fleets ~/.claude/skills/fleets

# Codex / Cursor / others that read .agents/skills
cp -r fleets .agents/skills/fleets
```

Agents using the skill get the full workflow: when to use it, the
manager/worker loops, scheduled compaction, and the rules. See
`SKILL.md`, and `AGENTS.md` for the full reference.

## Quick start

```
./fleet.ts init demo
./fleet.ts log demo --kind user --text "Ship the login fix today"
./fleet.ts log demo --kind manager --text "Plan: fix redirect, add test, update docs"
./fleet.ts spawn demo --task "Fix login redirect to /dashboard" --branch fix/login --name RedFox
./fleet.ts spawn demo --task "Check password reset flow end to end" --name CalmOwl
./fleet.ts status demo
./fleet.ts view demo
./fleet.ts report demo RedFox --text "Fixed redirect, added test, all green." --done
./fleet.ts compact demo
```

`status` is the manager's dashboard: message count, view size, tree
build state, nodes waiting on the LLM, agents, tasks, recent lines.
`view` shows the whole chat compressed; `zoom` opens any line into its
children, reads one message whole, or reads an agent's entire thread.

## How it works

Each project is a directory:

```
demo/
  main/                 messages, JSON lines, one file per day
  tree/                 summary nodes, JSON lines, one file per day
  main.index            binary index: 16 bytes per message slot
  tree.index            binary index: 16 bytes per tree slot
  view.json             materialized view
  compaction-queue.json logged nodes waiting on the scheduled compactor
  agents/<Name>.jsonl   one log per agent thread
  tasks.json            task queue: owner, branch, status
  work/<Name>/          working dir per agent
```

Message `i` is compressed into a node `(0,i)` of at most 512 bytes;
node `(l,i)` merges its two children. The view covers the chat to its
end with the most detail on the newest messages. Nodes are addressed as
`id+n`: the `n` messages from `id` on (`0+4` covers messages 0-3).
`compact` builds every node whose source already fits; for the rest it
logs the refs to `compaction-queue.json`, and a scheduled compactor task
drains the queue out of band with `ready --one` and `store-node`.

By default projects live next to `fleet.ts` (override with `--root` or
`$FLEET_ROOT`). They are per-machine runtime state and are git-ignored.

## Commands

| Command | What it does |
|---|---|
| `init <project>` | Create a project |
| `log <project> --kind <k> --text <t>` | Append to the global chat |
| `view <project>` | Read the compressed whole-chat view |
| `zoom <project> <id+n\|id\|Name>` | Open a line, read a message, read an agent's thread |
| `spawn <project> --task <t> [--name N] [--branch B]` | Start an agent thread |
| `tell <project> <name> --message <m>` | Message an agent thread |
| `report <project> <name> --text <t> [--done]` | Inject an agent's report into the global chat |
| `status <project>` | Manager's dashboard |
| `agents <project>` / `tasks <project>` | List threads / tasks |
| `compact <project>` | Build fitting nodes; log the rest to the compaction queue |
| `ready <project> [--one <id+n>]` | List / read compaction tasks |
| `store-node <project> <id+n> --text <line>` | Store one LLM-written summary line |
| `tree <project>` | Print the view, then the tree level by level |

Run `./fleet.ts help` for the full list. Every command takes `--json`,
and text can come from `--text`, trailing words, `--file`, or stdin.

## Files

- `fleet.ts` — the CLI. One file, ~1,210 lines, no dependencies.
- `SKILL.md` — the Agent Skill definition: frontmatter plus the
  workflow agents follow when the skill is active.
- `AGENTS.md` — the full reference for agents working in this repo.
- `README.md` — this file, for humans.

## Inspiration

The memory model (append-only logs with binary indexes, summary tree,
view, zoom, agent threads with reports injected into global chat) is
adapted from [UniiChat](https://github.com/VictorTaelin/UniiChat) by
Victor Taelin. This project keeps the memory system and leaves out the
multi-user server, billing, and device/computer-use parts.
