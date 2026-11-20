#!/usr/bin/env node
// fleet - single-file CLI for a fleet of coding agents.
// Port of the UniiChat memory idea (github.com/VictorTaelin/UniiChat,
// Memory.ts / Tools.ts), simplified for a local fleet workspace.
//
// One project = one never-ending global chat plus one thread per agent.
//   <root>/<project>/
//     main/               messages, JSON lines, one file per day
//     tree/               summary nodes, JSON lines, one file per day
//     main.index          binary index: 16 bytes per message slot
//     tree.index          binary index: 16 bytes per tree slot
//     view.json           materialized view + pick/goal/work
//     compaction-queue.json logged nodes waiting on the scheduled compactor
//     agents/<Name>.jsonl one log per agent thread
//     tasks.json          task queue: owner, branch, status
//     work/<Name>/        working dir per agent
//
// The global chat grows a binary summary tree: node (0,i) is message i
// in at most NODE bytes, node (l,i) merges its two children. A view
// lists nodes covering the chat, recent messages whole, older ones
// broad. Zoom opens any line into its children, down to the message.
// Agents report back into the global chat as [Name] work messages.
//
// Compaction runs out of band, on a schedule. The CLI never calls a
// model; the LLM is the manager's scheduled compactor task, not an
// API call inside this CLI. The CLI builds only nodes whose source
// already fits in NODE bytes. Anything longer goes on a queue:
//   `fleet compact` builds what fits, then logs what still needs the
//   LLM to `compaction-queue.json` in the project dir.
//   Every 30 minutes a scheduled compactor task reads the queue back
//   and drains it: it reads each task with
//   `fleet ready <project> --one <id+n>` and stores its line with
//   `fleet store-node <project> <id+n> --text <line>`.
// Storing a node can unblock its parent, which may then fit or need
// the LLM in turn. There is no truncation fallback: every summary
// line is written by the LLM through `store-node`.
// The manager never blocks on compaction and never spawns a compactor
// inline; see SKILL.md ("Scheduled compaction").
//
// Run with Node 22+ (default) or Bun:
//   node fleet.ts help
//   node fleet.ts init demo
//   node fleet.ts log demo --kind user --text "Ship the login fix"
//   node fleet.ts spawn demo --task "Fix login redirect" --branch fix/login
//   node fleet.ts status demo
//   node fleet.ts view demo
//   node fleet.ts zoom demo 0+4
//   node fleet.ts compact demo            (builds what fits, logs the rest to the queue)
//   node fleet.ts ready demo --one 6+1    (scheduled compactor reads one task)
//   node fleet.ts store-node demo 6+1 --text "one-line summary"  (compactor stores it)
//
// Root: --root <dir> wins, else $FLEET_ROOT, else the dir holding this
// file. Projects are subdirectories of the root.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------- types

export type Kind = "user" | "manager" | "work" | "unii" | "tool" | "echo" | "note";
export type Msg = { kind: Kind; text: string; date?: string; images?: string[]; line?: string; more?: boolean; act?: string };
type Root = Msg & { i: number; size: number; date: string };
type Part = { l: number; i: number };
type View = { parts: Part[]; size: number; batch: boolean; high: number };
type Stream = "main" | "tree";
type End = [number, number];
type Kept = { parts: Array<[number, number]>; batch: boolean };
type Saved = Kept & { seen?: Kept; main: End; tree: End; pick: string | null; goal?: string | null; work?: string[] };
type TaskStatus = "working" | "idle" | "done" | "blocked";
type Task = { id: number; agent: string; task: string; branch?: string; status: TaskStatus; created: string; updated: string };

type Memory = {
  dir: string;
  count: number;
  open: number;
  pick: string | null;
  goal: string | null;
  work: string[];
  nodes: Map<number, string>;
  view: View;
  seen: View;
  ends: Record<Stream, End>;
};

// ---------------------------------------------------------------- consts

const NODE = 512;
const HIGH = 128000;
const SEEN_HIGH = 32000;
const SLOT = 16;
const DAY = 864e5;
const CAP = 30000;
const WAIT = "(not summarized yet: zoom it)";
const VERSION = "fleet 0.3.0 (UniiChat-memory port, scheduled out-of-band compaction)";

// ------------------------------------------------------------- names
// Agent names: adjective + noun, e.g. FireAnt. Port of Names.ts.

const ADJS = ("red blue green yellow orange purple pink brown black white gray silver golden " +
  "amber azure bronze copper jade lemon lime mint navy peach plum ruby violet cherry honey " +
  "big small tiny huge giant little tall short long round flat thick thin deep soft hard " +
  "smooth rough fuzzy fluffy shiny crunchy crispy leafy spiky hot cold warm cool icy frosty " +
  "snowy rainy sunny cloudy windy stormy foggy misty sweet sour salty spicy juicy minty nutty " +
  "creamy smoky tasty fresh bright dark quiet loud happy jolly merry calm brave bold clever " +
  "wise kind gentle lucky proud quick swift fast slow eager busy sleepy silly funny shy neat " +
  "noble grand royal mighty strong steady nimble lively cozy old new young ancient wooden " +
  "stone paper iron magic cosmic lunar solar polar wild").split(/\s+/).filter(Boolean);
const NOUNS = ("ant bat bear bee beetle bird bison camel cat cheetah chicken clam cobra cougar " +
  "cow crab crane crow deer dog dolphin donkey dove dragon duck eagle eel elk falcon finch " +
  "fish flamingo fox frog gazelle gecko giraffe goat goose gorilla hamster hare hawk hedgehog " +
  "heron hippo horse hyena iguana jaguar jay kangaroo kitten koala lamb lemur leopard lion " +
  "lizard llama lobster moose moth mouse mule octopus orca otter owl ox oyster panda parrot " +
  "pelican penguin pig pigeon pony puffin puma rabbit raccoon raven rhino robin salmon seal " +
  "shark sheep shrimp skunk sloth snail snake sparrow spider squid squirrel swan tiger toad " +
  "toucan trout tuna turkey turtle walrus wasp whale wolf wombat yak zebra apple banana bagel " +
  "cookie mango melon muffin noodle pancake pepper potato pretzel radish taco waffle").split(/\s+/).filter(Boolean);

function capWord(w: string): string { return w[0].toUpperCase() + w.slice(1); }
function nameRandom(): string {
  const a = ADJS[Math.floor(Math.random() * ADJS.length)];
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return capWord(a) + capWord(n);
}
function validAgentName(name: string): boolean { return /^[A-Za-z][A-Za-z-]*$/.test(name); }
function validProjectName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && name !== "fleet.ts" && !name.endsWith(".ts");
}

// ---------------------------------------------------------------- clip
// CAP chars per page. Port of Clip.ts.

function clipEnd(str: string, at: number): number {
  if (str.length - at <= CAP) return str.length;
  const nl = str.lastIndexOf("\n", at + CAP - 1);
  const low = (str.charCodeAt(at + CAP) >> 10) === 0x37;
  return nl >= at ? nl + 1 : at + CAP - (low ? 1 : 0);
}
function clipPages(str: string): string[] {
  const pages: string[] = [];
  let at = 0;
  do {
    const end = clipEnd(str, at);
    pages.push(str.slice(at, end));
    at = end;
  } while (at < str.length);
  return pages;
}
function clipPage(str: string, at: number): string {
  const end = clipEnd(str, at);
  const on = "\n[characters " + (at + 1) + "-" + end + " of " + str.length + "; go on with at " + end + "]";
  return str.slice(at, end) + (end < str.length ? on : "");
}

// ------------------------------------------------------------ fs utils

function bytes(text: string): number { return Buffer.byteLength(text, "utf8"); }
function dayToday(): number { return Date.parse(new Date().toLocaleDateString("sv-SE")) / DAY; }
function dayStr(day: number): string { return new Date(day * DAY).toISOString().slice(0, 10); }
function ensureDir(dir: string): void { fs.mkdirSync(dir, { recursive: true }); }

function atomicWrite(file: string, data: string): void {
  fs.writeFileSync(file + ".new", data);
  fs.renameSync(file + ".new", file);
  syncFile(file);
}
function syncFile(file: string): void {
  try {
    const fd = fs.openSync(file, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch { /* best effort on filesystems without fsync */ }
}
function parseLine(line: string, file: string): any | null {
  try { return JSON.parse(line); } catch {
    if (line !== "") console.error("skipped a line of " + file + ": not JSON");
    return null;
  }
}
function readJsonFile<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return fallback; }
}
function flat(text: string): string {
  if (!text.includes("\n")) return text;
  return text.replace(/\s*\n\s*/g, " ");
}

// ------------------------------------------------------------ memory core

function slot(l: number, i: number): number { return (2 * i + 1) * 2 ** l - 1; }
function span(part: Part): [number, number] {
  const a = part.i * 2 ** part.l;
  return [a, a + 2 ** part.l - 1];
}
function halves(part: Part): Part[] {
  return part.l === 0 ? [] : [{ l: part.l - 1, i: 2 * part.i }, { l: part.l - 1, i: 2 * part.i + 1 }];
}
function ctx(l: number, i: number): number { return l === 0 ? i : (i + 1) * 2 ** l; }
function ref(part: Part): string { return part.i * 2 ** part.l + "+" + 2 ** part.l; }
function lineOf(part: Part, text: string): string { return ref(part) + "|" + flat(text); }

function streamPath(dir: string, stream: Stream, day: number): string {
  return dir + "/" + stream + "/" + dayStr(day) + ".jsonl";
}

function loadMemory(dir: string): Memory {
  ensureDir(dir + "/main");
  ensureDir(dir + "/tree");
  ensureDir(dir + "/agents");
  ensureDir(dir + "/work");
  const mem: Memory = {
    dir, count: 0, open: 0, pick: null, goal: null, work: [],
    nodes: new Map(),
    view: { parts: [], size: 0, batch: false, high: HIGH },
    seen: { parts: [], size: 0, batch: false, high: SEEN_HIGH },
    ends: { main: [0, 0], tree: [0, 0] },
  };
  const saved = savedView(dir);
  mem.pick = saved?.pick ?? null;
  mem.goal = saved?.goal ?? null;
  mem.work = saved?.work ?? [];
  mem.ends.main = indexLog(mem, "main", saved?.main ?? [0, 0]);
  mem.ends.tree = indexLog(mem, "tree", saved?.tree ?? [0, 0]);
  const idxFile = dir + "/main.index";
  mem.count = fs.existsSync(idxFile) ? Math.floor(fs.statSync(idxFile).size / SLOT) : 0;
  while (mem.count > 0 && messageAt(mem, mem.count - 1)?.more) mem.count -= 1;
  openView(mem, mem.view, saved);
  openView(mem, mem.seen, saved?.seen ?? saved);
  fit(mem);
  saveView(mem);
  return mem;
}

function savedView(dir: string): Saved | null {
  try { return JSON.parse(fs.readFileSync(dir + "/view.json", "utf8")) as Saved; } catch { return null; }
}

function openView(mem: Memory, view: View, kept: Kept | null): void {
  const keys = kept === null ? null : new Set(kept.parts.map(([l, i]) => slot(l, i)));
  view.parts = roots(mem.count).flatMap((part) => down(mem, part, keys));
  view.size = view.parts.reduce((n, part) => n + nodeSize(mem, part), 0);
  view.batch = kept?.batch ?? false;
}

function saveView(mem: Memory): void {
  const file = mem.dir + "/view.json";
  const keep = (view: View): Kept => ({ parts: view.parts.map((p) => [p.l, p.i] as [number, number]), batch: view.batch });
  const chat = keep(mem.view);
  const seen = keep(mem.seen);
  atomicWrite(file, JSON.stringify({ ...chat, seen, pick: mem.pick, goal: mem.goal, work: mem.work, main: mem.ends.main, tree: mem.ends.tree }));
}

function indexLog(mem: Memory, stream: Stream, from: End): End {
  const file = mem.dir + "/" + stream + ".index";
  let end: End = fs.existsSync(file) ? from : [0, 0];
  ensureDir(mem.dir + "/" + stream);
  const fd = fs.openSync(file, end[0] === 0 ? "w+" : "r+");
  try {
    const days = fs.readdirSync(mem.dir + "/" + stream)
      .map((f) => Date.parse(f.slice(0, 10)) / DAY)
      .filter((d) => Number.isFinite(d));
    for (const day of days.filter((d) => d >= end[0]).sort((a, b) => a - b)) {
      end = [day, scanDay(mem, stream, day, day === end[0] ? end[1] : 0, fd)];
    }
  } finally { fs.closeSync(fd); }
  return end;
}

function scanDay(mem: Memory, stream: Stream, day: number, at: number, fd: number): number {
  const file = streamPath(mem.dir, stream, day);
  const size = fs.statSync(file).size;
  if (size <= at) return at;
  const data = fs.readFileSync(file).subarray(at);
  let k = 0;
  for (let nl = data.indexOf(10); nl >= 0; nl = data.indexOf(10, k)) {
    const rec = parseLine(data.subarray(k, nl).toString("utf8"), file);
    if (rec !== null) placeRecord(mem, fd, stream, rec, day, at + k, nl - k);
    k = nl + 1;
  }
  if (k < data.length) {
    console.error("skipped the last line of " + file + ": cut short");
    fs.appendFileSync(file, "\n");
    return at + data.length + 1;
  }
  return at + k;
}

function placeRecord(mem: Memory, fd: number, stream: Stream, rec: any, day: number, at: number, length: number): void {
  void mem;
  if (rec.i === undefined) return;
  const buf = Buffer.alloc(SLOT);
  buf.writeDoubleLE(at, 0);
  buf.writeUInt32LE(day, 8);
  buf.writeUInt32LE(length, 12);
  const off = (stream === "main" ? rec.i : slot(rec.l, rec.i)) * SLOT;
  fs.writeSync(fd, buf, 0, SLOT, off);
}

function readAt(stream: Stream, mem: Memory, sl: number): any | null {
  const idxFile = mem.dir + "/" + stream + ".index";
  if (!fs.existsSync(idxFile)) return null;
  const idxFd = fs.openSync(idxFile, "r");
  try {
    const rec = Buffer.alloc(SLOT);
    const got = fs.readSync(idxFd, rec, 0, SLOT, sl * SLOT);
    if (got < SLOT) return null;
    const day = rec.readUInt32LE(8);
    if (day === 0) return null;
    const at = rec.readDoubleLE(0);
    const len = rec.readUInt32LE(12);
    const dataFd = fs.openSync(streamPath(mem.dir, stream, day), "r");
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(dataFd, buf, 0, len, at);
      return JSON.parse(buf.toString("utf8"));
    } finally { fs.closeSync(dataFd); }
  } catch { return null; } finally { fs.closeSync(idxFd); }
}

function logRecords(mem: Memory, stream: Stream, recs: object[]): void {
  if (recs.length === 0) return;
  const day = dayToday();
  const file = streamPath(mem.dir, stream, day);
  ensureDir(mem.dir + "/" + stream);
  const lines = recs.map((r) => JSON.stringify(r));
  const fd = fs.openSync(file, "a");
  let at: number;
  try {
    at = fs.fstatSync(fd).size;
    fs.writeSync(fd, lines.map((l) => l + "\n").join(""));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  const idxFd = fs.openSync(mem.dir + "/" + stream + ".index", "r+");
  try {
    for (let k = 0; k < lines.length; k++) {
      placeRecord(mem, idxFd, stream, recs[k] as any, day, at, bytes(lines[k]));
      at += bytes(lines[k]) + 1;
    }
  } finally { fs.closeSync(idxFd); }
  mem.ends[stream] = [day, at];
}

function makeRoot(i: number, msg: Msg): Root {
  const date = msg.date ?? new Date().toISOString();
  const images = msg.images?.length ? msg.images : undefined;
  const root: Root = { ...msg, text: msg.text.toWellFormed(), i, size: 0, date, images };
  root.size = bytes(showRoot(root));
  return root;
}

function showRoot(root: Root): string {
  const pics = (root.images ?? []).map((n) => "\n[image " + n + "]");
  return root.kind + ": " + root.text + pics.join("");
}

function messageAt(mem: Memory, i: number): Root | null {
  if (!Number.isInteger(i) || i < 0 || i >= mem.count) return null;
  return readAt("main", mem, i) as Root | null;
}

// Split one message into pages (CAP chars each). Images stay on the
// last pages in UniiChat; here we keep them on the first page only
// since this CLI does not serve images yet.
function pagesOf(msg: Msg): Msg[] {
  const texts = clipPages(msg.text);
  return texts.map((text, k) => ({
    ...msg,
    text,
    images: k === 0 ? msg.images : undefined,
    line: k === 0 ? msg.line : undefined,
    more: (k < texts.length - 1 || msg.more === true) ? true : undefined,
    act: k === texts.length - 1 ? msg.act : undefined,
  }));
}

function pushMessages(mem: Memory, msgs: Msg[]): Root[] {
  const roots = msgs.flatMap(pagesOf).map((m, k) => makeRoot(mem.count + mem.open + k, m));
  const done = roots.findLastIndex((r) => !r.more) + 1;
  const ids = Array.from({ length: done === 0 ? 0 : mem.open + done }, (_, k) => mem.count + k);
  logRecords(mem, "main", roots);
  mem.open += roots.length - ids.length;
  mem.count += ids.length;
  // Fast path: a node whose source fits needs no compactor.
  for (const i of ids) {
    const part = { l: 0, i };
    const src = sourceOf(mem, 0, i);
    if (src !== null && bytes(src) <= NODE && nodeText(mem, part) === null) {
      storeNodes(mem, [{ l: 0, i, text: src }]);
    }
  }
  fit(mem, true);
  saveView(mem);
  return roots;
}

function wholeFrom(mem: Memory, from: number): number {
  let k = mem.count;
  let size = 0;
  for (; k > from; k--) {
    const r = messageAt(mem, k - 1);
    if (!r) break;
    size += r.size;
    if (k < mem.count && size > HIGH) return k;
  }
  return k;
}

// ------------------------------------------------------------ tree

function built(mem: Memory, l: number, i: number): boolean {
  return mem.nodes.has(slot(l, i)) || nodeText(mem, { l, i }) !== null;
}
function nodeText(mem: Memory, part: Part): string | null {
  const key = slot(part.l, part.i);
  const kept = mem.nodes.get(key);
  if (kept !== undefined) return kept;
  const rec = readAt("tree", mem, key) as { text?: string } | null;
  if (rec?.text !== undefined) { mem.nodes.set(key, rec.text); return rec.text; }
  return null;
}
function nodeSize(mem: Memory, part: Part): number {
  const t = nodeText(mem, part);
  return t === null ? 0 : bytes(t);
}
function textOf(mem: Memory, part: Part): string {
  return nodeText(mem, part) ?? WAIT;
}

function roots(count: number): Part[] {
  const out: Part[] = [];
  for (let l = 30, id = 0; l >= 0; l--) {
    if (id + 2 ** l <= count) { out.push({ l, i: id / 2 ** l }); id += 2 ** l; }
  }
  return out;
}

function down(mem: Memory, part: Part, keys: Set<number> | null): Part[] {
  const key = slot(part.l, part.i);
  const text = nodeText(mem, part);
  if (text !== null) mem.nodes.set(key, text);
  if (part.l === 0 || (text !== null && (keys === null || keys.has(key)))) return [part];
  return halves(part).flatMap((h) => down(mem, h, keys));
}

function sourceOf(mem: Memory, l: number, i: number): string | null {
  if (l === 0) {
    const r = messageAt(mem, i);
    return r === null ? null : (r.line ?? showRoot(r));
  }
  const [a, b] = halves({ l, i }).map((h) => nodeText(mem, h));
  return a === null || b === null ? null : flat(a) + "\n" + flat(b);
}

function storeNodes(mem: Memory, parts: Array<Part & { text: string }>): void {
  const fresh = parts.filter((p) => nodeText(mem, p) === null);
  if (fresh.length === 0) return;
  logRecords(mem, "tree", fresh.map(({ l, i, text }) => ({ l, i, text, size: bytes(text) })));
  for (const { l, i, text } of fresh) {
    mem.nodes.set(slot(l, i), text);
    [mem.view, mem.seen].forEach((v) => { if (l === 0 && i < viewEnd(v)) v.size += bytes(text); });
  }
}

// Nodes not built whose halves are built, under part. A leaf has no
// halves, so every([]) is true and an unbuilt leaf is ready.
function todoUnder(mem: Memory, part: Part, out: Part[] = []): Part[] {
  if (nodeText(mem, part) !== null) return out;
  const hs = halves(part);
  if (hs.every((h) => nodeText(mem, h) !== null)) out.push(part);
  for (const h of hs) todoUnder(mem, h, out);
  return out;
}
function readyNodes(mem: Memory): Part[] {
  const all: Part[] = [];
  for (const r of roots(mem.count)) todoUnder(mem, r, all);
  all.sort((a, b) => ctx(a.l, a.i) - ctx(b.l, b.i) || b.l - a.l);
  return all;
}

// ------------------------------------------------------- compaction
// The CLI never calls a model. It builds only nodes whose source fits
// in NODE bytes. Longer ready nodes are logged to compaction-queue.json
// and wait for the scheduled compactor task, which reads them via
// `ready` and stores lines via `store-node` (see the commands below).
// There is no truncation path.

const QUEUE_FILE = "compaction-queue.json";
const SCALE = "-".repeat(NODE);

// Build every ready node whose source fits, level by level, until no
// more fit or we hit the cap. Returns how many nodes were built.
function compactFitting(mem: Memory, cap = 10000): number {
  let made = 0;
  for (;;) {
    const ready = readyNodes(mem);
    if (ready.length === 0 || made >= cap) break;
    const batch: Array<Part & { text: string }> = [];
    for (const p of ready) {
      if (made + batch.length >= cap) break;
      const src = sourceOf(mem, p.l, p.i);
      if (src === null || bytes(src) > NODE) continue;
      batch.push({ ...p, text: src });
    }
    if (batch.length === 0) break;
    storeNodes(mem, batch);
    made += batch.length;
  }
  if (made > 0) { fit(mem); saveView(mem); }
  return made;
}

// Ready nodes whose source is too long to be its own node: these need
// the LLM. Each entry carries its source for the agent to compress.
function nodesNeedingLLM(mem: Memory): Array<Part & { source: string; size: number }> {
  const out: Array<Part & { source: string; size: number }> = [];
  for (const p of readyNodes(mem)) {
    const src = sourceOf(mem, p.l, p.i);
    if (src === null) continue;
    const size = bytes(src);
    if (size > NODE) out.push({ ...p, source: src, size });
  }
  return out;
}

// The compaction queue: the out-of-band handoff between `compact` and
// the scheduled compactor task. `compact` (and `store-node`) rewrite
// the whole file with the current pending set, so it never goes stale
// with stored refs; the scheduled task drains the live queue via
// `ready`, which derives the same set from the tree. When nothing
// needs the LLM the file records an empty queue with a fresh
// timestamp, so a scheduled run can see the project is clean.
type QueueEntry = { ref: string; l: number; i: number; bytes: number };
type CompactionQueue = { project: string; updated: string; count: number; nodes: QueueEntry[] };

function queueFile(dir: string): string { return dir + "/" + QUEUE_FILE; }

function writeCompactionQueue(mem: Memory, project: string, need: Array<Part & { size: number }>): CompactionQueue {
  const queue: CompactionQueue = {
    project,
    updated: new Date().toISOString(),
    count: need.length,
    nodes: need.map((p) => ({ ref: ref(p), l: p.l, i: p.i, bytes: p.size })),
  };
  atomicWrite(queueFile(mem.dir), JSON.stringify(queue, null, 2) + "\n");
  return queue;
}

function readCompactionQueue(dir: string): CompactionQueue | null {
  return readJsonFile<CompactionQueue | null>(queueFile(dir), null);
}

// The compaction task for one node, in UniiChat's LEAF/MERGE shape:
// what to compress, the ruler, the view context, and the input.
function compactionTask(mem: Memory, part: Part, source: string): string {
  const [a, z] = span(part);
  const n = 2 ** part.l / 2;
  const context = viewLines(mem, ctx(part.l, part.i)).slice(-10);
  const head = part.l === 0
    ? "Compaction: compress message " + a + " into one line of at most " + NODE + " bytes\n(about 70 words), the length of this ruler:\n" + SCALE + "\n"
    : "Compaction: merge lines " + a + "+" + n + " and " + (a + n) + "+" + n + ", adjacent, into one line of at most\n" +
      NODE + " bytes (about 70 words), the length of this ruler:\n" + SCALE + "\n" +
      "<chat> may hold their messages, " + a + " to " + z + ", in more detail: take details\nof them from there too.\n";
  const rules = "Rules: output only the line, without an id+n| head. Keep user words closest to verbatim; " +
    "then lasting effects and failures; then findings; least of all tool steps. " +
    "Copy names, numbers, ids, paths and errors exactly. Never make anything look further along than it was.\n";
  const chat = context.length > 0 ? "<chat>\n" + context.join("\n") + "\n</chat>\n" : "";
  return head + rules + chat + "<input>\n" + source + "\n</input>\n" +
    "Store the line with: fleet store-node <project> " + ref(part) + " --text <line>";
}

// ------------------------------------------------------------ view

function viewEnd(view: View): number {
  return view.parts.length === 0 ? 0 : span(view.parts[view.parts.length - 1])[1] + 1;
}
function cover(view: View, id: number): number {
  let [a, z] = [0, view.parts.length];
  while (a < z) {
    const m = (a + z) >> 1;
    [a, z] = span(view.parts[m])[1] < id ? [m + 1, z] : [a, m];
  }
  return a;
}
function held(mem: Memory, part: Part): boolean {
  return [mem.view, mem.seen].some((view) => {
    const k = cover(view, span(part)[0]);
    return k === view.parts.length || view.parts[k].l <= part.l;
  });
}

function fit(mem: Memory, next = false): void {
  const gone: Part[] = [];
  let changed = false;
  reach(mem, mem.view, mem.count);
  reach(mem, mem.seen, mem.count);
  for (const view of [mem.view, mem.seen]) {
    const [n, batch] = [view.parts.length, view.batch];
    if (view.size > view.high || (next && view.batch)) {
      const merged = mergeView(mem, view);
      if (next || merged.size <= Math.max(view.high / 2, view.size - view.high)) {
        [view.parts, view.size] = [merged.parts, merged.size];
        gone.push(...merged.gone);
      }
      view.batch = view.size > view.high / 2;
    }
    changed = changed || view.parts.length !== n || view.batch !== batch;
  }
  gone.filter((p) => !held(mem, p)).forEach((p) => mem.nodes.delete(slot(p.l, p.i)));
  if (changed) saveView(mem);
}

function reach(mem: Memory, view: View, end: number): void {
  for (const part of view.parts.splice(cover(view, end))) view.size -= nodeSize(mem, part);
  for (let i = viewEnd(view); i < end; i++) {
    view.parts.push({ l: 0, i });
    view.size += nodeSize(mem, { l: 0, i });
  }
}

// Merge the most-due adjacent pairs down to half, as parents allow.
// Due = (T+1)/2^l - i, T the view end: age from last message in halves.
function mergeView(mem: Memory, from: View): { parts: Part[]; size: number; gone: Part[] } {
  const [t, low] = [viewEnd(from), from.high / 2];
  const view: Array<Part | null> = [...from.parts];
  const gone: Part[] = [];
  const nxt = view.map((_, k) => k + 1);
  const prv = view.map((_, k) => k - 1);
  type HeapItem = { d: number; k: number; a: Part; b: Part };
  const heap: HeapItem[] = [];
  const over = (x: HeapItem, y: HeapItem) => x.d > y.d || (x.d === y.d && x.k < y.k);
  const swap = (x: number, y: number) => { const tmp = heap[x]; heap[x] = heap[y]; heap[y] = tmp; };
  const offer = (k: number) => {
    const [a, b] = [view[k], view[nxt[k]]];
    if (k < 0 || !a || !b || a.i % 2 !== 0 || b.l !== a.l || b.i !== a.i + 1) return;
    if (nodeText(mem, { l: a.l + 1, i: a.i / 2 }) === null) return;
    heap.push({ d: (t + 1) / 2 ** a.l - a.i, k, a, b });
    for (let x = heap.length - 1; x > 0 && over(heap[x], heap[(x - 1) >> 1]); x = (x - 1) >> 1) swap(x, (x - 1) >> 1);
  };
  const take = (): HeapItem => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let x = 0; ;) {
        const m = [x, 2 * x + 1, 2 * x + 2].reduce((mm, c) => (c < heap.length && over(heap[c], heap[mm]) ? c : mm));
        if (m === x) break;
        swap(x, m); x = m;
      }
    }
    return top;
  };
  let size = from.size;
  view.forEach((_, k) => offer(k));
  while (heap.length > 0 && size > low) {
    const { k, a, b } = take();
    const j = nxt[k];
    if (view[k] !== a || view[j] !== b) continue;
    const up = { l: a.l + 1, i: a.i / 2 };
    size += nodeSize(mem, up) - nodeSize(mem, a) - nodeSize(mem, b);
    [view[k], view[j]] = [up, null];
    nxt[k] = nxt[j];
    if (nxt[j] < view.length) prv[nxt[j]] = k;
    gone.push(a, b);
    offer(prv[k]);
    offer(k);
  }
  return { parts: view.filter((p): p is Part => p !== null), size, gone };
}

function viewLines(mem: Memory, end = mem.count, parts = mem.view.parts): string[] {
  const lines: string[] = [];
  for (const p of parts) {
    const [a, b] = span(p);
    if (b >= end) continue;
    void a;
    lines.push(lineOf(p, textOf(mem, p)));
  }
  return lines;
}

function parsePart(mem: Memory, id: number, n: number): Part | null {
  const l = Math.log2(n);
  const ok = Number.isInteger(id) && Number.isInteger(l) && id >= 0 && id % n === 0 && id + n <= mem.count;
  return ok ? { l, i: id / n } : null;
}

function zoom(mem: Memory, id: number, n: number, at: number): string {
  const part = parsePart(mem, id, n);
  const root = n === 1 ? messageAt(mem, id) : null;
  if (part === null) {
    const rs = roots(mem.count).map((r) => ref(r)).join(", ");
    return "No line " + id + "+" + n + ": n is a power of 2, id a multiple of n. The tree's roots: " + rs + ".";
  }
  if (root !== null) {
    return id + "+0|" + showRoot({ ...root, text: clipPage(root.text, at) });
  }
  return halves(part).map((h) => lineOf(h, nodeText(mem, h) ?? WAIT)).join("\n");
}

function levelsOf(mem: Memory): number[] {
  return Array.from({ length: Math.max(1, mem.count.toString(2).length) }, (_, l) => l);
}
function* levelNodes(mem: Memory, l: number): Generator<[Part, string]> {
  for (let i = 0; (i + 1) * 2 ** l <= mem.count; i++) {
    const t = nodeText(mem, { l, i });
    if (t !== null) yield [{ l, i }, t];
  }
}
function countBuilt(mem: Memory): { built: number; total: number; unbuilt: number } {
  let total = 0;
  let builtN = 0;
  // Total nodes in the forest covering count messages: for each root,
  // 2^(l+1)-1 nodes. Count via traversal of ready+built instead.
  const seen = new Set<number>();
  const walk = (p: Part): void => {
    const key = slot(p.l, p.i);
    if (seen.has(key)) return;
    seen.add(key);
    total += 1;
    if (nodeText(mem, p) !== null) builtN += 1;
    for (const h of halves(p)) walk(h);
  };
  for (const r of roots(mem.count)) walk(r);
  return { built: builtN, total, unbuilt: total - builtN };
}

// ------------------------------------------------------- agents + tasks

function agentFile(dir: string, name: string): string { return dir + "/agents/" + name + ".jsonl"; }

function agentLog(dir: string, name: string): Root[] | null {
  const file = agentFile(dir, name);
  if (!validAgentName(name) || !fs.existsSync(file)) return null;
  const data = fs.readFileSync(file, "utf8");
  if (data !== "" && !data.endsWith("\n")) fs.appendFileSync(file, "\n");
  return data.split("\n").flatMap((ln) => parseLine(ln, file) ?? []);
}

function agentNames(dir: string): string[] {
  const d = dir + "/agents";
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => f.endsWith(".jsonl")).map((f) => f.replace(/\.jsonl$/, "")).sort();
}

function agentNew(dir: string, want?: string): string {
  ensureDir(dir + "/agents");
  if (want !== undefined) {
    if (!validAgentName(want)) throw new Error("bad agent name " + want + ": letters and hyphens, starting with a letter");
    const file = agentFile(dir, want);
    if (fs.existsSync(file)) throw new Error("agent " + want + " already exists");
    fs.writeFileSync(file, "", { flag: "wx" });
    return want;
  }
  for (let tries = 0; tries < 100; tries++) {
    const name = nameRandom();
    try { fs.writeFileSync(agentFile(dir, name), "", { flag: "wx" }); return name; }
    catch (e: any) { if (e.code !== "EEXIST") throw e; }
  }
  throw new Error("could not draw a free agent name");
}

function agentPush(dir: string, name: string, kind: Kind, text: string): number {
  const log = agentLog(dir, name);
  if (log === null) throw new Error("no agent " + name);
  const root = makeRoot(log.length, { kind, text });
  const file = agentFile(dir, name);
  const fd = fs.openSync(file, "a");
  try { fs.writeSync(fd, JSON.stringify(root) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return root.i;
}

function agentShow(dir: string, name: string): string {
  const log = agentLog(dir, name);
  if (log === null) return "No agent " + name + ".";
  return log.map((r) => r.i + "|" + showRoot(r)).join("\n\n");
}

function tasksFile(dir: string): string { return dir + "/tasks.json"; }
function loadTasks(dir: string): Task[] { return readJsonFile<Task[]>(tasksFile(dir), []); }
function saveTasks(dir: string, tasks: Task[]): void { atomicWrite(tasksFile(dir), JSON.stringify(tasks, null, 2) + "\n"); }
function taskForAgent(dir: string, agent: string): Task | undefined {
  return loadTasks(dir).find((t) => t.agent === agent);
}
function setTaskStatus(dir: string, agent: string, status: TaskStatus): void {
  const tasks = loadTasks(dir);
  const t = tasks.find((x) => x.agent === agent);
  if (t) { t.status = status; t.updated = new Date().toISOString(); saveTasks(dir, tasks); }
}

// ------------------------------------------------------------- root

function defaultRoot(): string {
  const env = process.env.FLEET_ROOT;
  if (env) return env.startsWith("~/") ? path.join(os.homedir(), env.slice(2)) : env;
  try {
    // Node and Bun both expose the current file's dir here.
    const here = (import.meta as any).dir as string | undefined;
    if (here) return here;
  } catch { /* fall through */ }
  return path.join(os.homedir(), "workspace", "fleet");
}

function projectDir(root: string, project: string): string {
  if (!validProjectName(project)) throw new Error("bad project name " + JSON.stringify(project));
  return path.join(root, project);
}
function requireProject(root: string, project: string): string {
  const dir = projectDir(root, project);
  if (!fs.existsSync(dir + "/view.json") && !fs.existsSync(dir + "/main")) {
    throw new Error("no project " + project + " under " + root + " (run: fleet init " + project + ")");
  }
  return dir;
}

// -------------------------------------------------------------- CLI

type Opts = Record<string, string | boolean>;
function parseArgs(argv: string[]): { cmd: string; pos: string[]; opts: Opts } {
  const pos: string[] = [];
  const opts: Opts = {};
  let cmd = "";
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const eq = key.indexOf("=");
      if (eq >= 0) { opts[key.slice(0, eq)] = key.slice(eq + 1); continue; }
      const next = argv[k + 1];
      if (next !== undefined && !next.startsWith("--")) { opts[key] = next; k++; }
      else opts[key] = true;
    } else if (cmd === "") cmd = a;
    else pos.push(a);
  }
  return { cmd, pos, opts };
}
function optText(opts: Opts, ...keys: string[]): string | undefined {
  for (const k of keys) { const v = opts[k]; if (typeof v === "string") return v; }
  return undefined;
}
function readTextInput(opts: Opts, pos: string[], fromIdx: number): string {
  const fromFile = optText(opts, "file");
  if (fromFile) return fs.readFileSync(fromFile, "utf8");
  const direct = optText(opts, "text", "message", "task");
  if (direct !== undefined) return direct;
  const rest = pos.slice(fromIdx).join(" ");
  if (rest) return rest;
  // Stdin, when piped.
  if (!process.stdin.isTTY) {
    try { return fs.readFileSync(0, "utf8"); } catch { /* fall through */ }
  }
  return "";
}
function fail(msg: string): never {
  console.error("fleet: " + msg);
  process.exit(1);
}
function outJson(obj: unknown): void { console.log(JSON.stringify(obj, null, 2)); }

const HELP = `fleet ${VERSION}
Usage: fleet <command> [args] [--root <dir>] [--json]

  init <project>                        create a fleet project
  log <project> --kind <k> --text <t>   append to the global chat
  view <project> [--end N]              print the compressed view (oldest first)
  zoom <project> <id+n|id|Name> [--at N] open a summary line, a message, or an agent log
  spawn <project> --task <t> [--name N] [--branch B]
                                        start an agent thread, print its name
  tell <project> <name> --message <m>   send a message to an agent thread
  report <project> <name> --text <t> [--done]
                                        inject [Name] report into global chat
  status <project>                      counts, view size, agents, tasks, recent lines
  agents <project>                      list agent threads with log lengths
  tasks <project>                       list tasks
  compact <project>                     build nodes whose source fits; log the rest
                                        to compaction-queue.json for the scheduled compactor
  ready <project> [--one <id+n>]        list nodes waiting on scheduled compaction
  store-node <project> <id+n> --text <t> store one LLM-written summary line (<=512 B)
  tree <project>                        print the tree by level
  help                                  this help

Kinds: user, manager, work, unii, tool, echo, note.
Text can come from --text / --message / --task, trailing words, --file, or stdin.
Root: --root, else $FLEET_ROOT, else the dir holding fleet.ts.

Scheduled compaction (out of band; the LLM is the scheduled task, not this CLI):
  1. fleet compact <project>   builds what fits, logs the rest to compaction-queue.json
  2. every 30 minutes the scheduled compactor task runs (see SKILL.md)
  3. it runs: fleet ready <project> --one <id+n>   (reads one task)
  4. it runs: fleet store-node <project> <id+n> --text <line>
  5. it repeats until the queue is empty, then re-runs fleet compact
`;

// --------------------------------------------------------- commands

function cmdInit(root: string, pos: string[]): void {
  const project = pos[0];
  if (!project) fail("init needs a project name");
  const dir = projectDir(root, project);
  if (fs.existsSync(dir + "/view.json")) fail("project " + project + " already exists at " + dir);
  const mem = loadMemory(dir);
  saveTasks(dir, []);
  console.log("created " + dir);
  console.log("messages: " + mem.count + ", view lines: " + mem.view.parts.length);
}

function cmdLog(root: string, pos: string[], opts: Opts): void {
  const project = pos[0];
  if (!project) fail("log needs a project name");
  const dir = requireProject(root, project);
  const kind = (optText(opts, "kind") ?? "manager") as Kind;
  if (!["user", "manager", "work", "unii", "tool", "echo", "note"].includes(kind)) fail("bad kind " + kind);
  const text = readTextInput(opts, pos, 1);
  if (!text) fail("log needs text: --text, trailing words, --file, or stdin");
  const mem = loadMemory(dir);
  const line = optText(opts, "line");
  const act = optText(opts, "act");
  const roots = pushMessages(mem, [{ kind, text, line, act }]);
  const first = roots[0];
  const last = roots[roots.length - 1];
  if (opts.json) outJson({ project, id: first.i, end: last.i + 1, pages: roots.length, count: mem.count });
  else console.log("logged " + first.i + (roots.length > 1 ? ".." + last.i : "") + " (" + kind + ", " + mem.count + " messages)");
}

function cmdView(root: string, pos: string[], opts: Opts): void {
  const project = pos[0];
  if (!project) fail("view needs a project name");
  const dir = requireProject(root, project);
  const mem = loadMemory(dir);
  const end = opts.end !== undefined ? Number(opts.end) : mem.count;
  const lines = viewLines(mem, end);
  if (opts.json) {
    outJson({ project, count: mem.count, end, viewBytes: mem.view.size, viewLines: lines.length, lines });
    return;
  }
  console.log("<chat> " + mem.count + " messages, view " + mem.view.size + " bytes, " + lines.length + " lines");
  for (const l of lines) console.log(l);
  console.log("</chat>");
}

function cmdZoom(root: string, pos: string[], opts: Opts): void {
  const project = pos[0];
  const target = pos[1];
  if (!project || !target) fail("usage: zoom <project> <id+n|id|Name>");
  const dir = requireProject(root, project);
  const at = Number(opts.at ?? 0);
  if (/^[A-Za-z]/.test(target)) {
    const text = agentShow(dir, target);
    console.log(at ? clipPage(text, at) : text);
    return;
  }
  const mem = loadMemory(dir);
  const m = target.match(/^(\d+)(?:\+(\d+))?$/);
  if (!m) fail("bad zoom target " + target + ": use id+n, id, or an agent Name");
  const id = Number(m[1]);
  const n = m[2] !== undefined ? Number(m[2]) : 1;
  console.log(zoom(mem, id, n, at));
}

function cmdSpawn(root: string, pos: string[], opts: Opts): void {
  const project = pos[0];
  if (!project) fail("spawn needs a project name");
  const dir = requireProject(root, project);
  const task = readTextInput(opts, pos, 1);
  if (!task) fail("spawn needs a task: --task, trailing words, --file, or stdin");
  const want = optText(opts, "name");
  const branch = optText(opts, "branch");
  const name = agentNew(dir, want);
  ensureDir(dir + "/work/" + name);
  const mem = loadMemory(dir);
  agentPush(dir, name, "note", "subagent" + (branch ? " on branch " + branch : ""));
  agentPush(dir, name, "user", task);
  const tasks = loadTasks(dir);
  const now = new Date().toISOString();
  tasks.push({ id: tasks.length === 0 ? 1 : Math.max(...tasks.map((t) => t.id)) + 1, agent: name, task, branch, status: "working", created: now, updated: now });
  saveTasks(dir, tasks);
  mem.work = [...new Set([...mem.work, name])];
  saveView(mem);
  if (opts.json) outJson({ project, agent: name, task, branch: branch ?? null, workDir: "work/" + name });
  else console.log("Started " + name + ". Its report will reach the global chat with: fleet report " + project + " " + name + " --text <report>");
}

function cmdTell(root: string, pos: string[], opts: Opts): void {
  const [project, name] = pos;
  if (!project || !name) fail("usage: tell <project> <name> --message <text>");
  const dir = requireProject(root, project);
  const message = readTextInput(opts, pos, 2);
  if (!message) fail("tell needs a message");
  const id = agentPush(dir, name, "user", message);
  setTaskStatus(dir, name, "working");
  if (opts.json) outJson({ project, agent: name, id });
  else console.log("Sent to " + name + " (log line " + id + ").");
}

function cmdReport(root: string, pos: string[], opts: Opts): void {
  const [project, name] = pos;
  if (!project || !name) fail("usage: report <project> <name> --text <report>");
  const dir = requireProject(root, project);
  const text = readTextInput(opts, pos, 2);
  if (!text) fail("report needs text");
  const log = agentLog(dir, name);
  if (log === null) fail("no agent " + name);
  agentPush(dir, name, "unii", text);
  const mem = loadMemory(dir);
  pushMessages(mem, [{ kind: "work", text: "[" + name + "]\n" + text }]);
  if (opts.done) {
    setTaskStatus(dir, name, "done");
    mem.work = mem.work.filter((w) => w !== name);
    saveView(mem);
  } else {
    setTaskStatus(dir, name, "idle");
  }
  if (opts.json) outJson({ project, agent: name, count: mem.count, done: opts.done === true });
  else console.log("Reported [" + name + "] into the global chat (" + mem.count + " messages).");
}

function cmdStatus(root: string, pos: string[], opts: Opts): void {
  const project = pos[0];
  if (!project) fail("status needs a project name");
  const dir = requireProject(root, project);
  const mem = loadMemory(dir);
  const tree = countBuilt(mem);
  const tasks = loadTasks(dir);
  const agents = agentNames(dir).map((name) => {
    const log = agentLog(dir, name) ?? [];
    const task = tasks.find((t) => t.agent === name);
    return { name, lines: log.length, status: task?.status ?? "idle", task: task?.task ?? null, branch: task?.branch ?? null };
  });
  const recent = viewLines(mem).slice(-8);
  const need = nodesNeedingLLM(mem);
  const queue = readCompactionQueue(dir);
  const data = {
    project, dir, count: mem.count, open: mem.open,
    viewBytes: mem.view.size, viewLines: mem.view.parts.length,
    treeBuilt: tree.built, treeTotal: tree.total, treeUnbuilt: tree.unbuilt,
    needsLLM: need.length, readyRefs: need.map((p) => ref(p)),
    queue,
    agents, tasks,
    working: mem.work,
    goal: mem.goal, pick: mem.pick,
    recent,
  };
  if (opts.json) { outJson(data); return; }
  console.log("fleet status: " + project + " (" + dir + ")");
  console.log("messages: " + mem.count + " (open pages: " + mem.open + "), view: " + mem.view.parts.length + " lines, " + mem.view.size + " bytes");
  console.log("tree: " + tree.built + "/" + tree.total + " nodes built, " + tree.unbuilt + " unbuilt");
  if (need.length > 0) console.log("compaction needed: " + need.length + " node(s) waiting: " + need.map((p) => ref(p)).slice(0, 5).join(", ") + " (queued in " + QUEUE_FILE + "; the scheduled compactor drains them)");
  else if (queue !== null) console.log("compaction queue: empty (last logged " + queue.updated + ")");
  if (mem.goal) console.log("goal: " + mem.goal);
  console.log("agents (" + agents.length + "):");
  for (const a of agents) console.log("  - " + a.name + " [" + a.status + "] " + a.lines + " lines" + (a.branch ? " branch " + a.branch : "") + (a.task ? " :: " + flat(a.task).slice(0, 100) : ""));
  if (tasks.length > 0) {
    console.log("tasks (" + tasks.length + "):");
    for (const t of tasks) console.log("  #" + t.id + " " + t.agent + " [" + t.status + "] " + flat(t.task).slice(0, 120));
  }
  if (recent.length > 0) {
    console.log("recent view lines:");
    for (const l of recent) console.log("  " + l.slice(0, 220));
  }
}

function cmdAgents(root: string, pos: string[], opts: Opts): void {
  const project = pos[0];
  if (!project) fail("agents needs a project name");
  const dir = requireProject(root, project);
  const tasks = loadTasks(dir);
  const rows = agentNames(dir).map((name) => {
    const log = agentLog(dir, name) ?? [];
    const t = tasks.find((x) => x.agent === name);
    return { name, lines: log.length, status: t?.status ?? "idle", task: t?.task ?? null };
  });
  if (opts.json) { outJson({ project, agents: rows }); return; }
  if (rows.length === 0) { console.log("no agents yet"); return; }
  for (const r of rows) console.log(r.name + " [" + r.status + "] " + r.lines + " lines" + (r.task ? " :: " + flat(r.task).slice(0, 120) : ""));
}

function cmdTasks(root: string, pos: string[], opts: Opts): void {
  const project = pos[0];
  if (!project) fail("tasks needs a project name");
  const dir = requireProject(root, project);
  const tasks = loadTasks(dir);
  if (opts.json) { outJson({ project, tasks }); return; }
  if (tasks.length === 0) { console.log("no tasks yet"); return; }
  for (const t of tasks) console.log("#" + t.id + " " + t.agent + " [" + t.status + "]" + (t.branch ? " " + t.branch : "") + " " + flat(t.task));
}

function cmdCompact(root: string, pos: string[], opts: Opts): void {
  const project = pos[0];
  if (!project) fail("compact needs a project name");
  const dir = requireProject(root, project);
  const mem = loadMemory(dir);
  const before = countBuilt(mem);
  if (opts.naive || opts.native) fail("--naive was removed: compaction is scheduled out-of-band only. Run fleet compact " + project + " to queue nodes; the scheduled compactor stores lines with fleet store-node.");
  const made = compactFitting(mem);
  const need = nodesNeedingLLM(mem);
  const queue = writeCompactionQueue(mem, project, need);
  const after = countBuilt(mem);
  const refs = need.map((p) => ref(p));
  if (opts.json) {
    outJson({ project, mode: "llm", made, before, after, count: mem.count, needsLLM: need.length, refs, queueFile: QUEUE_FILE, queueUpdated: queue.updated });
    return;
  }
  console.log("compacted " + made + " fitting nodes (" + before.built + "/" + before.total + " -> " + after.built + "/" + after.total + " built)");
  if (need.length === 0) {
    console.log("no nodes need the LLM. Queue is empty (logged to " + QUEUE_FILE + ").");
    return;
  }
  console.log("needs LLM: " + need.length + " node(s): " + refs.slice(0, 10).join(", ") + (refs.length > 10 ? " (+" + (refs.length - 10) + " more)" : ""));
  console.log("logged to " + QUEUE_FILE + " for the scheduled compactor (every 30 minutes).");
}

function cmdReady(root: string, pos: string[], opts: Opts): void {
  const project = pos[0];
  if (!project) fail("ready needs a project name");
  const dir = requireProject(root, project);
  const mem = loadMemory(dir);
  const need = nodesNeedingLLM(mem);
  const one = optText(opts, "one");
  if (one !== undefined) {
    const m = one.match(/^(\d+)\+(\d+)$/);
    if (!m) fail("bad node ref " + one + ": use id+n");
    const part = parsePart(mem, Number(m[1]), Number(m[2]));
    if (part === null) fail("no node " + one);
    if (nodeText(mem, part) !== null) fail("node " + one + " is already built");
    const src = sourceOf(mem, part.l, part.i);
    if (src === null) fail("node " + one + " is not ready: its halves are not built yet");
    if (bytes(src) <= NODE) fail("node " + one + " fits already (" + bytes(src) + " bytes); run fleet compact " + project);
    if (opts.json) { outJson({ project, ref: one, l: part.l, i: part.i, span: span(part), bytes: bytes(src), task: compactionTask(mem, part, src), source: src }); return; }
    console.log(compactionTask(mem, part, src));
    return;
  }
  const limit = opts.limit !== undefined ? Number(opts.limit) : need.length;
  const rows = need.slice(0, limit).map((p) => ({ ref: ref(p), l: p.l, i: p.i, span: span(p), bytes: p.size, preview: flat(p.source).slice(0, 200) }));
  if (opts.json) { outJson({ project, count: need.length, nodes: rows }); return; }
  if (need.length === 0) { console.log("no nodes waiting on LLM compaction."); return; }
  console.log(need.length + " node(s) waiting on LLM compaction:");
  for (const r of rows) console.log("  " + r.ref + " lvl " + r.l + " (" + r.bytes + " bytes) " + r.preview);
  console.log("read one task with: fleet ready " + project + " --one " + rows[0].ref);
}

function cmdStoreNode(root: string, pos: string[], opts: Opts): void {
  const [project, target] = pos;
  if (!project || !target) fail("usage: store-node <project> <id+n> --text <line>");
  const dir = requireProject(root, project);
  const m = target.match(/^(\d+)\+(\d+)$/);
  if (!m) fail("bad node ref " + target + ": use id+n");
  const mem = loadMemory(dir);
  const part = parsePart(mem, Number(m[1]), Number(m[2]));
  if (part === null) fail("no node " + target + ": n is a power of 2, id a multiple of n, id+n <= " + mem.count);
  if (nodeText(mem, part) !== null) fail("node " + target + " is already built");
  const src = sourceOf(mem, part.l, part.i);
  if (src === null) fail("node " + target + " is not ready: its halves are not built yet");
  const raw = readTextInput(opts, pos, 2);
  const line = flat(raw.trim());
  if (line === "") fail("store-node needs a non-empty line");
  const size = bytes(line);
  if (size > NODE) fail("line is " + size + " bytes, over the " + NODE + "-byte limit; shorten it and try again");
  storeNodes(mem, [{ ...part, text: line }]);
  const unblocked = compactFitting(mem);
  fit(mem);
  saveView(mem);
  const after = countBuilt(mem);
  const stillNeed = nodesNeedingLLM(mem);
  writeCompactionQueue(mem, project, stillNeed);
  const still = stillNeed.length;
  if (opts.json) outJson({ project, ref: target, bytes: size, unblockedParents: unblocked, built: after.built, total: after.total, stillNeedingLLM: still });
  else console.log("stored " + target + " (" + size + " bytes)" + (unblocked > 0 ? ", unblocked " + unblocked + " fitting parent(s)" : "") + ". Tree: " + after.built + "/" + after.total + " built, " + still + " still needing the LLM.");
}

function cmdTree(root: string, pos: string[]): void {
  const project = pos[0];
  if (!project) fail("tree needs a project name");
  const dir = requireProject(root, project);
  const mem = loadMemory(dir);
  console.log("VIEW (" + mem.view.parts.length + " lines, " + mem.view.size + " bytes):");
  for (const p of mem.view.parts) console.log("  " + lineOf(p, textOf(mem, p)).slice(0, 220));
  for (const l of levelsOf(mem)) {
    console.log("LVL" + l + ":");
    for (const [p, t] of levelNodes(mem, l)) console.log("  " + lineOf(p, t).slice(0, 220));
  }
}

// ------------------------------------------------------------- main

function main(argv: string[]): void {
  const { cmd, pos, opts } = parseArgs(argv);
  const root = typeof opts.root === "string" ? opts.root : defaultRoot();
  try {
    switch (cmd) {
      case "": case "help": case "--help": case "-h": console.log(HELP); return;
      case "version": case "--version": console.log(VERSION); return;
      case "init": cmdInit(root, pos); return;
      case "log": cmdLog(root, pos, opts); return;
      case "view": cmdView(root, pos, opts); return;
      case "zoom": cmdZoom(root, pos, opts); return;
      case "spawn": cmdSpawn(root, pos, opts); return;
      case "tell": cmdTell(root, pos, opts); return;
      case "report": cmdReport(root, pos, opts); return;
      case "status": cmdStatus(root, pos, opts); return;
      case "agents": cmdAgents(root, pos, opts); return;
      case "tasks": cmdTasks(root, pos, opts); return;
      case "compact": cmdCompact(root, pos, opts); return;
      case "ready": cmdReady(root, pos, opts); return;
      case "store-node": cmdStoreNode(root, pos, opts); return;
      case "tree": cmdTree(root, pos); return;
      default: fail("unknown command " + JSON.stringify(cmd) + " (run: fleet help)");
    }
  } catch (e: any) {
    fail(String(e?.message ?? e));
  }
}

main(process.argv.slice(2));
