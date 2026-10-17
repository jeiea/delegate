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
import {
  type Agent,
  residentTitleMarker,
  stripDelegatePromptPrefix,
} from "./select.ts";

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
  /** 재개 뒤에도 상주 세션으로 다루기 위한 native 이름 표시 */
  resident: boolean;
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
  return await readSnapshot(
    onlyCandidate(sessionId, await listCandidates(env)),
  );
}

// 클로드는 세션을 백그라운드로 넘기면 새 ID로 이어 가고 원래 기록에만 continued-in을 남긴다.
// origins는 세션 ID 또는 delegate 호출자 표시처럼 하이픈을 뺀 앞부분이며 기록 하나로만 정해져야 한다.
export async function sessionsContinuedInto(
  sessionId: string,
  origins: string[],
  env: Record<string, string>,
): Promise<string[]> {
  if (origins.length === 0) return [];
  const candidates = (await listCandidates(env)).filter((candidate) =>
    candidate.agent === "claude"
  );
  const target = sessionId.toLowerCase();
  const reaches = async (id: string, seen: Set<string>): Promise<boolean> => {
    if (seen.has(id)) return false;
    seen.add(id);
    for (const next of await continuedSessionIds(id, candidates)) {
      if (next === target || await reaches(next, seen)) return true;
    }
    return false;
  };
  const reached = await Promise.all(origins.map((origin) => {
    const prefix = compactId(origin);
    const matched = candidates.filter((candidate) =>
      compactId(candidateId(candidate)).startsWith(prefix)
    );
    return matched.length === 1 &&
      reaches(candidateId(matched[0]!), new Set());
  }));
  return origins.filter((_, index) => reached[index]);
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
  // 미완료 턴의 답변은 클로드가 백그라운드 작업을 기다리며 멈춘 중간 답변뿐이다.
  const resultIndex = turns.findLastIndex((turn) => turn.assistant != null);
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

// 이어짐은 자동 선택 근거라 findNativeSession과 같은 유일성·경로 검증을 통과한 기록만 쓴다.
async function continuedSessionIds(
  sessionId: string,
  candidates: Candidate[],
): Promise<string[]> {
  let records: NativeRecord[];
  try {
    const path = await trustedPath(onlyCandidate(sessionId, candidates));
    records = decodeRecords(await Deno.readFile(path)).records;
  } catch (error) {
    if (error instanceof DelegateError) return [];
    throw error;
  }
  return records.map(({ value }) => object(value)).flatMap((record) =>
    record.type === "continued-in" &&
      typeof record.sessionId === "string" &&
      record.sessionId.toLowerCase() === sessionId &&
      typeof record.continuedInSessionId === "string"
      ? [record.continuedInSessionId.toLowerCase()]
      : []
  );
}

function onlyCandidate(sessionId: string, candidates: Candidate[]): Candidate {
  const matched = candidates.filter((candidate) =>
    candidateId(candidate) === sessionId.toLowerCase()
  );
  if (matched.length === 0) {
    throw new DelegateError(
      "session_not_found",
      `native session 없음: ${sessionId}`,
    );
  }
  if (matched.length > 1) {
    throw new DelegateError(
      "session_ambiguous",
      `native session 후보 복수: ${sessionId}`,
    );
  }
  return matched[0]!;
}

async function readSnapshot(candidate: Candidate): Promise<SharedSession> {
  const path = await trustedPath(candidate);
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
  // 클로드는 백그라운드 작업을 기다릴 때만 turn_duration 뒤에도 턴이 열려 있다.
  if (
    candidate.agent === "claude" && latest?.completed === false &&
    observation.last_activity?.kind === "request_completed"
  ) observation.last_activity = { kind: "background_wait" };
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
    resident: (parsed.title ??
      (candidate.agent === "codex"
        ? await codexTitle(candidate.root, parsed.sessionId)
        : undefined))?.split(" ")[0] === residentTitleMarker,
  };
}

// 코덱스 이름은 롤아웃이 아닌 이름 색인에 추가 기록되며 마지막 항목이 최신이다.
async function codexTitle(
  root: string,
  sessionId: string,
): Promise<string | undefined> {
  let text: string;
  try {
    text = await Deno.readTextFile(join(root, "session_index.jsonl"));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
  return latestIndexedTitle(text, sessionId);
}

function latestIndexedTitle(
  text: string,
  sessionId: string,
): string | undefined {
  let title: string | undefined;
  for (const line of text.split("\n")) {
    try {
      const entry = object(JSON.parse(line));
      if (String(entry.id).toLowerCase() === sessionId.toLowerCase()) {
        title = typeof entry.thread_name === "string"
          ? entry.thread_name
          : title;
      }
    } catch {
      // 기록 중인 마지막 줄은 다음 조회에서 읽는다.
    }
  }
  return title;
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

function compactId(sessionId: string): string {
  return sessionId.replaceAll("-", "").toLowerCase();
}

function candidateId(candidate: Candidate): string {
  const name = basename(candidate.path, ".jsonl").toLowerCase();
  return candidate.agent === "claude" ? name : name.slice(-36);
}

function inside(root: string, path: string): boolean {
  return path === root ||
    path.startsWith(root.endsWith(SEPARATOR) ? root : root + SEPARATOR);
}

async function trustedPath(candidate: Candidate): Promise<string> {
  const root = await realPathOrSelf(candidate.root);
  const path = await realPathOrSelf(candidate.path);
  if (!inside(root, path)) {
    throw new DelegateError(
      "unsafe_native_path",
      `native session 경로가 신뢰 root 밖입니다: ${basename(candidate.path)}`,
    );
  }
  return path;
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
