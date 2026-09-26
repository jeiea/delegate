import { basename, join, relative, SEPARATOR } from "jsr:@std/path@1.1.6";
import { object, publicEvents } from "./activity.ts";
import { parseClaudeSession } from "./claude.ts";
import {
  type NativeRecord,
  parseCodexSession,
  type ParsedSession,
  type ParsedTurn,
} from "./codex.ts";
import {
  DelegateError,
  type NativeObservation,
  type NativeSessionId,
} from "./document.ts";
import { type Agent, stripDelegatePromptPrefix } from "./select.ts";

export const sessionIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type NativeCursor = {
  path: string;
  identity: string;
  byteLength: number;
  lastRecord: string | null;
  partial: boolean;
};

export type SharedSession = {
  sessionId: NativeSessionId;
  agent: Agent;
  cwd: string;
  path: string;
  cursor: NativeCursor;
  bytes: Uint8Array;
  turns: ParsedTurn[];
  observation: NativeObservation;
};

export type PromptOutcome = {
  result?: string;
  intervening_prompts?: string[];
};

export type PromptBoundary = {
  offset: number;
  excludeInitialTurn: boolean;
};

type Candidate = { agent: Agent; path: string; root: string };

export function assertSessionId(
  value: string,
): asserts value is NativeSessionId {
  if (!sessionIdPattern.test(value)) {
    throw new DelegateError(
      "invalid_session_id",
      `잘못된 native session ID: ${value}`,
    );
  }
}

export async function findNativeSession(
  sessionId: string,
  env: Record<string, string>,
): Promise<SharedSession> {
  assertSessionId(sessionId);
  const candidates = (await listCandidates(env)).filter((candidate) =>
    candidateId(candidate) === sessionId.toLowerCase()
  );
  if (candidates.length === 0) {
    throw new DelegateError(
      "session_not_found",
      `native session 없음: ${sessionId}`,
    );
  }
  if (candidates.length > 1) {
    throw new DelegateError(
      "session_ambiguous",
      `native session 후보 복수: ${sessionId}`,
    );
  }
  return await readSnapshot(candidates[0]!);
}

export async function refreshNativeSession(
  snapshot: SharedSession,
): Promise<SharedSession> {
  return await readSnapshot({
    agent: snapshot.agent,
    path: snapshot.path,
    root: rootForPath(snapshot.path, snapshot.agent),
  });
}

export function cursorEquals(
  left: NativeCursor,
  right: NativeCursor,
): boolean {
  return left.identity === right.identity &&
    left.byteLength === right.byteLength &&
    left.lastRecord === right.lastRecord && left.partial === right.partial;
}

export function continuesNativeSession(
  initial: SharedSession,
  current: SharedSession,
): boolean {
  return initial.cursor.identity === current.cursor.identity &&
    initial.bytes.length <= current.bytes.length &&
    initial.bytes.every((byte, index) => byte === current.bytes[index]);
}

export function outcomeAfter(
  snapshot: SharedSession,
  boundary: PromptBoundary,
): PromptOutcome {
  const turns = snapshot.turns.filter((turn) => turn.start >= boundary.offset);
  const resultIndex = turns.findLastIndex((turn) =>
    turn.completed && turn.assistant != null
  );
  if (resultIndex < 0) return {};
  const concluded = turns.slice(0, resultIndex + 1);
  const interveningPrompts = concluded.slice(
    boundary.excludeInitialTurn ? 1 : 0,
  ).map((turn) => stripDelegatePromptPrefix(turn.prompt));
  return {
    ...(interveningPrompts.length === 0
      ? {}
      : { intervening_prompts: interveningPrompts }),
    result: turns[resultIndex]!.assistant,
  };
}

export function latestHumanBoundary(snapshot: SharedSession): PromptBoundary {
  const turn = snapshot.turns.at(-1);
  return turn == null
    ? { offset: snapshot.cursor.byteLength, excludeInitialTurn: false }
    : { offset: turn.start, excludeInitialTurn: false };
}

export function renderConversation(snapshot: SharedSession): string {
  return snapshot.turns.flatMap((turn) => [
    `## User\n\n${turn.prompt}`,
    ...(turn.completed && turn.assistant != null
      ? [`## Assistant\n\n${turn.assistant}`]
      : []),
  ]).join("\n\n");
}

async function readSnapshot(candidate: Candidate): Promise<SharedSession> {
  const root = await realPathOrSelf(candidate.root);
  const path = await realPathOrSelf(candidate.path);
  if (!inside(root, path)) {
    throw new DelegateError(
      "unsafe_native_path",
      `native session 경로가 신뢰 root 밖입니다: ${basename(candidate.path)}`,
    );
  }
  const data = await Deno.readFile(path);
  const { records, partial } = decodeRecords(data);
  let parsed: ParsedSession;
  try {
    parsed = candidate.agent === "codex"
      ? parseCodexSession(records)
      : parseClaudeSession(records);
  } catch {
    throw new DelegateError(
      "invalid_native_session",
      `지원하지 않는 native session schema: ${basename(candidate.path)}`,
    );
  }
  const fileId = candidateId(candidate);
  if (
    parsed.sessionId == null || parsed.cwd == null ||
    parsed.sessionId.toLowerCase() !== fileId
  ) {
    throw new DelegateError(
      "invalid_native_session",
      `native session metadata 불일치: ${basename(candidate.path)}`,
    );
  }
  assertSessionId(parsed.sessionId);
  const info = await Deno.stat(path);
  const identity = `${String(info.dev ?? "")}:${String(info.ino ?? path)}`;
  const latest = parsed.turns.at(-1);
  const observation: NativeObservation = {
    request_state: latest == null
      ? "unknown"
      : latest.aborted
      ? "aborted"
      : latest.completed
      ? "completed"
      : "incomplete",
    partial_record: partial,
  };
  const tools = new Map<string, string>();
  for (const record of records) {
    const event = object(record.value);
    if (
      typeof event.timestamp === "string" &&
      Number.isFinite(Date.parse(event.timestamp))
    ) {
      observation.last_activity_at = event.timestamp;
    }
    const activity = publicEvents(candidate.agent, record.value, tools).at(-1);
    if (activity != null) observation.last_activity = activity;
  }
  return {
    sessionId: parsed.sessionId,
    agent: candidate.agent,
    cwd: parsed.cwd,
    path,
    bytes: data,
    cursor: {
      path,
      identity,
      byteLength: data.byteLength,
      lastRecord: recordIdentity(records.at(-1)),
      partial,
    },
    turns: parsed.turns,
    observation,
  };
}

function decodeRecords(data: Uint8Array): {
  records: NativeRecord[];
  partial: boolean;
} {
  const records: NativeRecord[] = [];
  let start = 0;
  for (let index = 0; index < data.length; index++) {
    if (data[index] !== 10) continue;
    const bytes = data.subarray(start, index);
    if (bytes.length > 0) {
      try {
        records.push({
          value: JSON.parse(new TextDecoder().decode(bytes)),
          start,
          end: index + 1,
        });
      } catch {
        throw new DelegateError(
          "invalid_native_session",
          "native session 중간 JSONL record가 잘못되었습니다",
        );
      }
    }
    start = index + 1;
  }
  return { records, partial: start < data.length };
}

function recordIdentity(record: NativeRecord | undefined): string | null {
  if (record == null) return null;
  const value = record.value as Record<string, unknown>;
  const payload = value.payload as Record<string, unknown> | undefined;
  return [
    value.type,
    value.uuid,
    value.timestamp,
    payload?.type,
    payload?.turn_id,
    record.end,
  ].filter((part) => part != null).join(":");
}

async function listCandidates(
  env: Record<string, string>,
): Promise<Candidate[]> {
  const home = env.HOME;
  const roots: Array<{ agent: Agent; root: string; search: string }> = [];
  const defaultHome = env.OS === "Windows_NT" ? env.USERPROFILE ?? home : home;
  const codexRoot = env.CODEX_HOME ??
    (defaultHome == null ? undefined : join(defaultHome, ".codex"));
  if (codexRoot != null) {
    roots.push({
      agent: "codex",
      root: codexRoot,
      search: join(codexRoot, "sessions"),
    });
  }
  const claudeRoot = env.CLAUDE_CONFIG_DIR ??
    (home == null ? undefined : join(home, ".claude"));
  if (claudeRoot != null) {
    roots.push({
      agent: "claude",
      root: claudeRoot,
      search: join(claudeRoot, "projects"),
    });
  }
  const candidates: Candidate[] = [];
  for (const spec of roots) {
    for (const path of await walkJsonl(spec.search)) {
      const rel = relative(spec.search, path);
      if (spec.agent === "codex") {
        if (/^rollout-.*-[0-9a-f-]{36}\.jsonl$/i.test(basename(path))) {
          candidates.push({ agent: spec.agent, path, root: spec.root });
        }
      } else if (
        !rel.split(SEPARATOR).includes("subagents") &&
        sessionIdPattern.test(basename(path, ".jsonl"))
      ) {
        candidates.push({ agent: spec.agent, path, root: spec.root });
      }
    }
  }
  return candidates;
}

async function walkJsonl(root: string): Promise<string[]> {
  const paths: string[] = [];
  const pending = [root];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let real: string;
    try {
      real = await Deno.realPath(directory);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
    if (visited.has(real)) continue;
    visited.add(real);
    for await (const entry of Deno.readDir(directory)) {
      const path = join(directory, entry.name);
      if (entry.isDirectory) pending.push(path);
      else if (entry.isSymlink) {
        const info = await Deno.stat(path);
        if (info.isDirectory) pending.push(path);
        else if (info.isFile && entry.name.endsWith(".jsonl")) paths.push(path);
      } else if (entry.isFile && entry.name.endsWith(".jsonl")) {
        paths.push(path);
      }
    }
  }
  return paths;
}

function candidateId(candidate: Candidate): string {
  const name = basename(candidate.path, ".jsonl").toLowerCase();
  return candidate.agent === "claude" ? name : name.slice(-36);
}

function inside(root: string, path: string): boolean {
  return path === root ||
    path.startsWith(root.endsWith(SEPARATOR) ? root : root + SEPARATOR);
}

async function realPathOrSelf(path: string): Promise<string> {
  try {
    return await Deno.realPath(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return path;
    throw error;
  }
}

function rootForPath(path: string, agent: Agent): string {
  const marker = agent === "codex"
    ? `${SEPARATOR}sessions${SEPARATOR}`
    : `${SEPARATOR}projects${SEPARATOR}`;
  const index = path.indexOf(marker);
  return index < 0 ? path : path.slice(0, index);
}
