import { basename, isAbsolute } from "jsr:@std/path@1.1.6";
import { TextLineStream } from "jsr:@std/streams@1.0.17/text-line-stream";
import { closeDirect, statusDirect, waitDirect } from "./direct.ts";
import type {
  DelegateDocument,
  DelegateWarning,
  PublicActivity,
  RetryRecord,
} from "./document.ts";
import {
  copyDelegateError,
  DelegateError,
  normalizeError,
  renderSessionHead,
} from "./document.ts";
import {
  cursorEquals,
  findNativeSession,
  latestHumanBoundary,
  type NativeCursor,
  outcomeAfter,
  type PromptOutcome,
  refreshNativeSession,
  sessionIdPattern,
  sessionsContinuedInto,
  type SharedSession,
} from "./native_session.ts";
import type { Exec, ExecResult } from "./process.ts";
import {
  type Agent,
  callerSessionId,
  type NativeInvocation,
  sessionTitle,
} from "./select.ts";

export type HerdrDeps = {
  exec: Exec;
  env: Record<string, string>;
  signal: AbortSignal;
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  stdout?: (text: string) => void | Promise<void>;
};

type PromptExecutionDeps = HerdrDeps & {
  callerSignal: AbortSignal;
  timeoutSignal: AbortSignal;
  executionSignal: AbortSignal;
};

export type HerdrPrompt = {
  invocation: NativeInvocation;
  cwd: string;
  snapshot?: SharedSession;
  callerId?: string;
  name?: string;
  timeoutMs: number;
  startOptionsSpecified: boolean;
  model?: string;
  warnings: readonly DelegateWarning[];
  detach: boolean;
  resident: boolean;
};

type HerdrResult = Record<string, unknown>;

type LiveAgent = {
  name: string;
  kind?: Agent;
  cwd?: string;
  status: string;
  sequence?: string;
  sessionKind?: string;
  sessionId?: string;
  workspaceId?: string;
  tabId?: string;
  paneId?: string;
};

type ManagedPane = LiveAgent & { paneId: string };

type OwnedPaneId = string | undefined;

class RetainPaneError extends DelegateError {}
class LiveAgentListError extends DelegateError {}

const paneLockWaitMs = 60_000;
const activityGateMs = 30_000;
const identityPollMs = 10_000;
const recoveryMs = 500;
const diagnosticMs = 1_000;

export async function promptHerdr(
  request: HerdrPrompt,
  deps: HerdrDeps,
): Promise<DelegateDocument> {
  const executionDeps = promptExecutionDeps(deps, request.timeoutMs);
  const deadline = executionDeps.now() + request.timeoutMs;
  const expected = request.snapshot;
  const expectedSessionId = expected?.sessionId;
  const assignedSessionId = expected == null &&
      request.invocation.agent === "claude"
    ? crypto.randomUUID()
    : undefined;
  const knownSessionId = expectedSessionId ?? assignedSessionId;
  let confirmedSessionId = knownSessionId;
  let retry: RetryRecord | undefined;
  let diagnostic: PaneTarget | undefined;
  let live = expected == null
    ? undefined
    : await findLiveAgent(expected, executionDeps);
  if (live != null && expected != null) {
    diagnostic = paneTarget(live, expected.agent, expected.cwd);
  }
  if (
    live != null && expected != null &&
    hasLiveOptionConflict(request, expected.agent)
  ) {
    throw new DelegateError(
      "live_option_conflict",
      "live session에는 시작 전용 옵션을 적용할 수 없습니다",
    );
  }
  const ignoredModel: DelegateWarning[] = live == null || request.model == null
    ? []
    : [{
      code: "resume_option_ignored",
      message: "live session에는 --model을 적용할 수 없어 무시했습니다",
      model: request.model,
    }];
  const model = live == null ? request.model : undefined;
  // 상주 여부는 시작·재개 때 정해지고 실행 중에는 Herdr 이름이 유지한다.
  const resident = live == null ? request.resident : isResidentName(live.name);
  const callerId = await withSessionError(
    resolveCallerId(
      request.callerId,
      executionDeps,
      expected?.cwd ?? request.cwd,
      live == null,
    ),
    expected?.sessionId,
  );
  let snapshot: SharedSession | undefined;
  try {
    let boundaryCursor: NativeCursor | undefined;
    if (live == null) {
      if (callerId == null) {
        throw new DelegateError(
          "caller_session_unavailable",
          "Herdr 신규 session의 caller ID를 확인할 수 없습니다",
        );
      }
      const started = await withPaneLock(
        { deadline, deps: executionDeps, sessionId: knownSessionId },
        async () => {
          const concurrent = expected == null
            ? undefined
            : await findLiveAgent(expected, executionDeps);
          if (concurrent != null) {
            throw new DelegateError(
              "live_session_ambiguous",
              "session이 다른 호출에서 재개되었습니다",
              undefined,
              expected?.sessionId,
            );
          }
          let ownership: OwnedPaneId;
          let ownedCwd = expected?.cwd ?? request.cwd;
          let startRetry: RetryRecord | undefined;
          try {
            const agentStart = await withSessionError(
              startAgent(
                request,
                callerId,
                assignedSessionId,
                deadline,
                executionDeps,
                (allocated, cwd) => {
                  ownership = allocated;
                  ownedCwd = cwd;
                },
                (target) => {
                  diagnostic = target;
                },
              ),
              knownSessionId,
            );
            startRetry = agentStart.retry;
            diagnostic = paneTarget(
              agentStart.live,
              request.invocation.agent,
              ownedCwd,
            );
            const submitted = await submitPromptOnly(
              request,
              agentStart.live,
              "started",
              knownSessionId,
              deadline,
              executionDeps,
            );
            return {
              ...submitted,
              ownership,
              ownedCwd,
              retry: agentStart.retry,
            };
          } catch (error) {
            const retainPane = error instanceof RetainPaneError;
            const preserved = copyDelegateError(normalizeError(error), {
              retry: startRetry,
            });
            // 호출자 중단은 바깥 catch에서 확인된 pane을 닫는다.
            if (
              !retainPane &&
              !["agent_blocked", "cancelled"].includes(preserved.code)
            ) {
              await recoverOwnedPane(ownership, ownedCwd, deps).catch(() => {});
            }
            throw preserved;
          }
        },
      );
      let submitted: Awaited<ReturnType<typeof identifySubmittedPrompt>>;
      try {
        submitted = await identifySubmittedPrompt(
          request,
          started,
          knownSessionId,
          deadline,
          executionDeps,
        );
      } catch (error) {
        const preserved = copyDelegateError(normalizeError(error), {
          retry: started.retry,
        });
        const retainPane = error instanceof RetainPaneError ||
          started.deliveryUncertain || isLifecycleError(preserved);
        if (!retainPane && preserved.code !== "agent_blocked") {
          await recoverOwnedPane(
            started.ownership,
            started.ownedCwd,
            deps,
          ).catch(() => {});
        }
        throw preserved;
      }
      live = submitted.live;
      snapshot = submitted.snapshot;
      boundaryCursor = submitted.boundaryCursor;
      retry = started.retry;
    } else {
      const submitted = await submitAndIdentify(
        request,
        live,
        "existing",
        knownSessionId,
        deadline,
        executionDeps,
      );
      live = submitted.live;
      diagnostic = paneTarget(live, request.invocation.agent, request.cwd);
      snapshot = submitted.snapshot;
      boundaryCursor = submitted.boundaryCursor;
    }
    confirmedSessionId = snapshot.sessionId;
    if (expected == null) {
      await executionDeps.stdout?.(renderSessionHead(snapshot.sessionId));
    }
    // 실행 중인 세션은 처음 띄운 호출자 표시를 유지한다.
    if (!isSessionAgentName(live.name, snapshot.sessionId)) {
      const deterministic = agentName(snapshot.sessionId, {
        resident,
        callerId,
      });
      await renameAgent(live.name, deterministic, snapshot, executionDeps);
      live.name = deterministic;
      if (diagnostic != null) {
        diagnostic = { ...diagnostic, name: deterministic };
      }
    }
    if (request.detach) {
      return document(snapshot, activityOf(live.status), {
        model,
        warnings: [...request.warnings, ...ignoredModel],
        retry,
      });
    }
    live.sessionId = snapshot.sessionId;
    live.kind = snapshot.agent;
    live.cwd = snapshot.cwd;

    const settled = await waitForQuiescence(
      snapshot,
      live,
      deadline,
      executionDeps,
    );
    const offset = boundaryCursor != null &&
        boundaryCursor.path === settled.snapshot.cursor.path &&
        boundaryCursor.identity === settled.snapshot.cursor.identity
      ? boundaryCursor.byteLength
      : 0;
    if (settled.snapshot.agent === "codex" && request.name != null) {
      await renameCodex(
        live,
        sessionTitle({ resident, callerId, name: request.name }),
        settled.snapshot.cwd,
        executionDeps,
      );
    }
    const warnings = await cleanupAutomatically(
      settled.live,
      settled.snapshot,
      deadline,
      executionDeps,
    );
    return document(
      settled.snapshot,
      "quiescent",
      {
        outcome: outcomeAfter(settled.snapshot, {
          offset,
          excludeInitialTurn: true,
        }),
        model,
        warnings: [...request.warnings, ...ignoredModel, ...warnings ?? []],
        retry,
      },
    );
  } catch (error) {
    const normalized = normalizeError(error);
    const preserved = copyDelegateError(normalized, {
      sessionId: normalized.sessionId ?? confirmedSessionId,
      retry: normalized.retry ?? retry,
    });
    if (diagnostic == null) throw preserved;
    throw preserved.code === "cancelled" && !request.detach && !resident
      ? await closeCancelledPane(preserved, diagnostic, snapshot, deps)
      : await diagnosePane(preserved, diagnostic, deps);
  }
}

async function renameAgent(
  from: string,
  to: string,
  snapshot: SharedSession,
  deps: HerdrDeps,
): Promise<void> {
  try {
    await withSessionError(
      json(snapshot.cwd, deps, ["agent", "rename", from, to]),
      snapshot.sessionId,
    );
  } catch (error) {
    const normalized = normalizeError(error);
    if (isLifecycleError(normalized)) throw normalized;
    throw new DelegateError(
      "live_session_ambiguous",
      normalized.message,
      undefined,
      normalized.sessionId,
      normalized.retry,
    );
  }
}

// 호출자 중단은 위임 작업도 멈춘다. 대화는 native 기록으로 재개한다.
async function closeCancelledPane(
  error: DelegateError,
  target: PaneTarget,
  snapshot: SharedSession | undefined,
  deps: HerdrDeps,
): Promise<DelegateError> {
  const recoveryDeps = { ...deps, signal: AbortSignal.timeout(recoveryMs) };
  try {
    if (snapshot == null) {
      await closePane(target.paneId, target.cwd, recoveryDeps);
    } else {
      // 이동한 pane은 session으로 다시 찾는다.
      await closeSessionPane(target.paneId, snapshot, {
        deadline: recoveryDeps.now() + recoveryMs,
        deps: recoveryDeps,
      });
    }
    return error;
  } catch (closeError) {
    return new DelegateError(
      error.code,
      `${error.message}; pane 정리 실패: ${normalizeError(closeError).message}`,
      { pane_id: target.paneId },
      error.sessionId,
      error.retry,
      error.screen,
    );
  }
}

type PaneTarget = {
  name: string;
  paneId: string;
  cwd: string;
  agent: Agent;
  sessionId?: string;
  strictPane?: boolean;
};

function paneTarget(
  live: LiveAgent,
  agent: Agent,
  cwd: string,
): PaneTarget | undefined {
  return live.paneId == null ? undefined : {
    name: live.name,
    paneId: live.paneId,
    cwd,
    agent,
    sessionId: live.sessionId,
  };
}

async function diagnosePane(
  error: DelegateError,
  target: PaneTarget,
  deps: HerdrDeps,
): Promise<DelegateError> {
  if (
    error.code !== "agent_blocked" && error.code !== "invalid_native_session" &&
    error.code !== "session_id_unavailable" && error.code !== "herdr_failed"
  ) return error;
  const signal = AbortSignal.any([
    deps.signal,
    AbortSignal.timeout(diagnosticMs),
  ]);
  try {
    let confirmed = false;
    let paneId = target.paneId;
    let checkPane = false;
    try {
      const result = await diagnosticCall(
        signal,
        () => json(target.cwd, deps, ["agent", "get", target.name], signal),
      );
      const reported = agentFromResult(result, target.name);
      const payload = Object.keys(objectValue(result.agent)).length === 0
        ? result
        : objectValue(result.agent);
      const reportedName = stringValue(payload.name) ??
        stringValue(payload.agent_name);
      const expectedSessionId = error.sessionId ?? target.sessionId;
      const sameAgent = (reportedName == null ||
        reportedName === target.name) &&
        (reported.cwd == null || reported.cwd === target.cwd) &&
        (reported.kind == null || reported.kind === target.agent) &&
        (reported.sessionId == null || expectedSessionId == null ||
          reported.sessionId.toLowerCase() === expectedSessionId.toLowerCase());
      if (!sameAgent) return error;
      if (
        target.strictPane && reported.paneId != null &&
        reported.paneId !== target.paneId
      ) return error;
      error = copyDelegateError(error, {
        sessionId: readReportedSessionId(reported, expectedSessionId),
      });
      if (reported.paneId == null) {
        checkPane = true;
      } else {
        confirmed = true;
        paneId = reported.paneId;
      }
    } catch {
      checkPane = true;
    }
    if (checkPane) {
      const result = await diagnosticCall(
        signal,
        () => json(target.cwd, deps, ["pane", "get", target.paneId], signal),
      );
      const pane = objectValue(result.pane);
      const agent = stringValue(pane.agent) ?? stringValue(pane.agent_name);
      // 이번 호출이 할당한 pane에서 에이전트가 시작 직후 종료되면 Herdr가 등록을 해제해 셸만 남는다.
      confirmed = stringValue(pane.pane_id) === target.paneId &&
        (agent === target.name ||
          (target.strictPane === true && agent == null));
    }
    if (!confirmed) return error;
    let screen: string | undefined;
    try {
      const output = await diagnosticCall(
        signal,
        () =>
          deps.exec(deps.env.HERDR_BIN_PATH ?? "herdr", [
            "pane",
            "read",
            paneId,
            "--source",
            "visible",
          ], {
            cwd: target.cwd,
            env: deps.env,
            signal,
          }),
      );
      if (output.code === 0) screen = output.stdout;
    } catch { /* 화면 조회 실패는 원래 오류를 유지한다. */ }
    return new DelegateError(
      error.code,
      error.message,
      { pane_id: paneId },
      error.sessionId,
      error.retry,
      screen,
    );
  } catch {
    return error;
  }
}

async function diagnosticCall<T>(
  signal: AbortSignal,
  command: () => Promise<T>,
): Promise<T> {
  if (signal.aborted) throw signal.reason;
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([command(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export async function diagnoseSessionPane(
  sessionId: string,
  cwd: string,
  deps: HerdrDeps,
  original?: DelegateError,
): Promise<DelegateError | undefined> {
  if (!sessionIdPattern.test(sessionId)) return undefined;
  const signal = AbortSignal.any([
    deps.signal,
    AbortSignal.timeout(diagnosticMs),
  ]);
  try {
    const result = await diagnosticCall(
      signal,
      () => json(cwd, deps, ["agent", "list"], signal),
    );
    const candidates = arrayObjects(result.agents).filter((value) =>
      isSessionAgentName(nameOf(value), sessionId) &&
      (sessionOf(value) == null ||
        sessionOf(value)?.toLowerCase() === sessionId.toLowerCase()) &&
      stringValue(value.cwd) === cwd
    );
    if (candidates.length !== 1) return undefined;
    const live = liveFrom(candidates[0]!);
    if (live.paneId == null || live.kind == null) return undefined;
    const name = live.name;
    const code = live.status === "blocked"
      ? "agent_blocked"
      : "invalid_native_session";
    const message = code === "agent_blocked"
      ? "에이전트가 사용자 입력을 기다립니다"
      : `native session을 찾을 수 없습니다: ${sessionId}`;
    const diagnosed = await diagnosePane(
      original ?? new DelegateError(code, message, undefined, sessionId),
      {
        name,
        paneId: live.paneId,
        cwd,
        agent: live.kind,
        sessionId,
      },
      { ...deps, signal },
    );
    return diagnosed.pane == null ? undefined : diagnosed;
  } catch {
    return undefined;
  }
}

export async function statusHerdr(
  snapshot: SharedSession,
  deps: HerdrDeps,
): Promise<DelegateDocument> {
  const live = await findLiveAgent(snapshot, deps);
  if (live == null) return statusDirect(snapshot);
  return document(
    snapshot,
    activityOf(live.status),
  );
}

export async function waitHerdr(
  snapshot: SharedSession,
  options: {
    timeoutMs: number;
    callerId?: string;
    name?: string;
  },
  deps: HerdrDeps,
): Promise<DelegateDocument> {
  const live = await findLiveAgent(snapshot, deps);
  if (live == null) {
    return await waitDirect(snapshot, {
      ...deps,
      timeoutMs: options.timeoutMs,
    });
  }
  const deadline = deps.now() + options.timeoutMs;
  const boundaryCursor = snapshot.cursor;
  const boundary = latestHumanBoundary(snapshot);
  const settled = await waitForQuiescence(snapshot, live, deadline, deps);
  if (snapshot.agent === "codex" && options.name != null) {
    const callerId = await withSessionError(
      resolveCallerId(options.callerId, deps, snapshot.cwd),
      snapshot.sessionId,
    );
    await renameCodex(
      live,
      sessionTitle({
        resident: isResidentName(live.name),
        callerId,
        name: options.name,
      }),
      snapshot.cwd,
      deps,
    );
  }
  const warnings = await cleanupAutomatically(
    settled.live,
    settled.snapshot,
    deadline,
    deps,
  );
  return document(
    settled.snapshot,
    "quiescent",
    {
      outcome: outcomeAfter(settled.snapshot, {
        ...boundary,
        offset: boundaryCursor.path === settled.snapshot.cursor.path &&
            boundaryCursor.identity === settled.snapshot.cursor.identity
          ? boundary.offset
          : 0,
      }),
      warnings,
    },
  );
}

export async function closeHerdr(
  snapshot: SharedSession,
  deps: HerdrDeps,
): Promise<DelegateDocument> {
  const live = await findLiveAgent(snapshot, deps);
  if (live == null) return closeDirect();
  if (live.paneId == null) {
    return document(snapshot, "not_live");
  }
  let paneId = live.paneId;
  if (["working", "blocked", "unknown"].includes(live.status)) {
    await json(snapshot.cwd, deps, [
      "agent",
      "send-keys",
      live.name,
      "ctrl+c",
    ]);
    try {
      paneId = (await getAgent(live, snapshot.cwd, deps, snapshot.sessionId))
        .paneId ?? paneId;
    } catch (error) {
      if (
        error instanceof DelegateError &&
        ["session_id_changed", "invalid_native_session"].includes(error.code)
      ) throw error;
      // 취소 직후 agent가 사라지는 것은 정상적인 정리 경로다.
    }
  }
  const deadline = deps.now() + paneLockWaitMs;
  await withPaneLock(
    {
      deadline,
      deps,
      sessionId: snapshot.sessionId,
    },
    () => closeSessionPane(paneId, snapshot, { deadline, deps }),
  );
  return document(snapshot, "not_live");
}

export function claudeTrustKeys(screen: string): string[] | undefined {
  const lines = screen.split("\n").map((line) => line.trim());
  const trust = lines.findIndex((line) =>
    /^(?:❯ )?Yes, I trust this folder$/.test(line)
  );
  const selected = lines.findIndex((line) =>
    /^❯ (?:No, exit|Yes, I trust this folder)$/.test(line)
  );
  if (trust < 0 || selected < 0 || Math.abs(trust - selected) > 1) return;
  if (trust === selected) return ["enter"];
  if (trust < selected) return ["up", "enter"];
  return ["down", "enter"];
}

async function submitPrompt(
  request: HerdrPrompt,
  live: LiveAgent,
  origin: "started" | "existing",
  deadline: number,
  deps: HerdrDeps,
): Promise<{ live: LiveAgent; deliveryUncertain: boolean }> {
  ensureTime(deadline, deps, request.snapshot?.sessionId);
  if (origin === "existing" && live.status === "blocked") {
    throw new DelegateError(
      "agent_blocked",
      "에이전트가 사용자 입력을 기다립니다",
      undefined,
      live.sessionId ?? request.snapshot?.sessionId,
    );
  }
  const activityGate = origin === "started" ||
    ["idle", "done"].includes(live.status);
  let prompted: HerdrResult;
  try {
    prompted = await json(
      live.cwd ?? request.snapshot?.cwd ?? request.cwd,
      deps,
      [
        "agent",
        "prompt",
        live.name,
        request.invocation.prompt,
        ...(activityGate
          ? [
            "--wait",
            "--until",
            "working",
            "--until",
            "blocked",
            "--timeout",
            activityGateTimeout(deadline, deps),
          ]
          : []),
      ],
    );
  } catch (error) {
    const normalized = normalizeError(error);
    // 완료까지 기다리면 결과로 전달을 확인한다. 분리 요청은 그럴 수 없어 아래에서 pane을 보존한 채 실패를 알린다.
    if (
      origin === "started" && !request.detach &&
      (normalized.code === "timeout" || error instanceof RetainPaneError)
    ) {
      return { live, deliveryUncertain: true };
    }
    if (normalized.code !== "agent_blocked") {
      if (origin === "started") {
        throw new RetainPaneError(
          normalized.code,
          normalized.message,
          normalized.pane,
          normalized.sessionId,
          normalized.retry,
          normalized.screen,
        );
      }
      throw normalized;
    }
    return {
      live: { ...live, status: "blocked" },
      deliveryUncertain: false,
    };
  }
  const promptedAgent = objectValue(prompted.agent);
  const result = Object.keys(promptedAgent).length === 0
    ? live
    : mergeReportedLive(live, liveFrom(promptedAgent, live.name));
  return { live: result, deliveryUncertain: false };
}

type SubmittedPrompt = {
  live: LiveAgent;
  boundaryCursor?: NativeCursor;
  awaitNewTurn: boolean;
  deliveryUncertain: boolean;
};

async function submitPromptOnly(
  request: HerdrPrompt,
  live: LiveAgent,
  origin: "started" | "existing",
  knownSessionId: string | undefined,
  deadline: number,
  deps: HerdrDeps,
): Promise<SubmittedPrompt> {
  readReportedSessionId(live, knownSessionId);
  const before = request.snapshot == null
    ? undefined
    : (await refreshNativeSession(request.snapshot)).cursor;
  const statusBeforePrompt = live.status;
  const prompted = await submitPrompt(request, live, origin, deadline, deps);
  return {
    live: prompted.live,
    boundaryCursor: before,
    // 분리 요청은 결과 경계가 필요 없어 진행 중 turn 뒤의 새 turn을 기다리지 않는다.
    awaitNewTurn: !request.detach && origin === "existing" &&
      ["working", "unknown"].includes(statusBeforePrompt),
    deliveryUncertain: prompted.deliveryUncertain,
  };
}

async function identifySubmittedPrompt(
  request: HerdrPrompt,
  submitted: SubmittedPrompt,
  knownSessionId: string | undefined,
  deadline: number,
  deps: HerdrDeps,
): Promise<{
  live: LiveAgent;
  snapshot: SharedSession;
  boundaryCursor?: NativeCursor;
}> {
  const prompted = submitted.live;
  let identified: SharedSession;
  try {
    identified = await waitForNativeSession(
      request,
      prompted,
      knownSessionId,
      deadline,
      deps,
    );
  } catch (error) {
    const normalized = normalizeError(error);
    if (prompted.status === "blocked") {
      throw new RetainPaneError(
        normalized.code === "invalid_native_session"
          ? "agent_blocked"
          : normalized.code,
        normalized.code === "invalid_native_session"
          ? "에이전트가 사용자 입력을 기다립니다"
          : normalized.message,
        normalized.pane,
        normalized.sessionId,
        normalized.retry,
        normalized.screen,
      );
    }
    throw normalized;
  }
  if (prompted.status === "blocked") {
    throw new DelegateError(
      "agent_blocked",
      "에이전트가 사용자 입력을 기다립니다",
      undefined,
      identified.sessionId,
    );
  }
  if (submitted.awaitNewTurn) {
    identified = await waitForNewTurn(
      identified,
      submitted.boundaryCursor,
      deadline,
      deps,
    );
  }
  return {
    live: prompted,
    snapshot: identified,
    boundaryCursor: submitted.boundaryCursor,
  };
}

async function submitAndIdentify(
  request: HerdrPrompt,
  live: LiveAgent,
  origin: "started" | "existing",
  knownSessionId: string | undefined,
  deadline: number,
  deps: HerdrDeps,
): Promise<{
  live: LiveAgent;
  snapshot: SharedSession;
  boundaryCursor?: NativeCursor;
}> {
  const submitted = await submitPromptOnly(
    request,
    live,
    origin,
    knownSessionId,
    deadline,
    deps,
  );
  return await identifySubmittedPrompt(
    request,
    submitted,
    knownSessionId,
    deadline,
    deps,
  );
}

async function withPaneLock<T>(
  options: {
    deadline: number;
    deps: HerdrDeps;
    sessionId?: string;
  },
  operation: () => Promise<T>,
): Promise<T> {
  const { deadline, deps, sessionId } = options;
  ensureTime(deadline, deps, sessionId);
  const socketPath = deps.env.HERDR_SOCKET_PATH;
  if (socketPath == null || socketPath === "" || !isAbsolute(socketPath)) {
    throw new DelegateError(
      "transport_unavailable",
      "Herdr의 절대 socket 경로를 확인할 수 없습니다",
      undefined,
      sessionId,
    );
  }
  let file: Deno.FsFile;
  try {
    file = await Deno.open(`${socketPath}.delegate-pane.lock`, {
      create: true,
      read: true,
      write: true,
    });
  } catch (error) {
    throw new DelegateError(
      "herdr_failed",
      error instanceof Error ? error.message : String(error),
      undefined,
      sessionId,
    );
  }
  try {
    while (!await file.tryLock(true)) {
      ensureTime(deadline, deps, sessionId);
      await pause(Math.min(50, remaining(deadline, deps)), deps, sessionId);
    }
    ensureTime(deadline, deps, sessionId);
    try {
      return await operation();
    } finally {
      try {
        await file.unlock();
      } catch {
        // close도 잠금을 해제하므로 주 작업 결과를 unlock 진단으로 덮지 않는다.
      }
    }
  } finally {
    file.close();
  }
}

async function startAgent(
  request: HerdrPrompt,
  callerId: string,
  assignedSessionId: string | undefined,
  deadline: number,
  deps: HerdrDeps,
  allocated: (ownership: OwnedPaneId, cwd: string) => void,
  located: (target: PaneTarget) => void,
): Promise<{
  live: ManagedPane;
  retry?: RetryRecord;
}> {
  const cwd = request.snapshot?.cwd ?? request.cwd;
  const sessionId = request.snapshot?.sessionId ?? assignedSessionId;
  const name = sessionId == null
    ? temporaryAgentName(callerId)
    : agentName(sessionId, { ...request, callerId });
  const paneId = await allocatePane(request, cwd, callerId, deps, (paneId) => {
    allocated(paneId, cwd);
    located({
      name,
      paneId,
      cwd,
      agent: request.invocation.agent,
      sessionId: assignedSessionId ?? request.snapshot?.sessionId,
      strictPane: true,
    });
  });
  const herdrArgs = request.invocation.agent === "claude"
    ? [
      ...request.invocation.herdrArgs.filter((arg) =>
        !arg.startsWith("--name=")
      ),
      `--name=${sessionTitle({ ...request, callerId })}`,
      ...(assignedSessionId == null
        ? []
        : [`--session-id=${assignedSessionId}`]),
    ]
    : request.invocation.herdrArgs;
  const start = async () => {
    ensureTime(deadline, deps, request.snapshot?.sessionId);
    const result = await json(cwd, deps, [
      "agent",
      "start",
      name,
      "--kind",
      request.invocation.agent,
      "--pane",
      paneId,
      "--timeout",
      activityGateTimeout(deadline, deps),
      "--",
      ...herdrArgs,
    ]);
    return agentFromResult(result, name);
  };
  let retry: RetryRecord | undefined;
  let started: LiveAgent | undefined;
  let blocked: DelegateError | undefined;
  try {
    try {
      started = await start();
    } catch (error) {
      const normalized = normalizeError(error);
      if (
        normalized.code !== "herdr_failed" ||
        normalized.message !==
          `agent target pane ${paneId} is not an available shell`
      ) throw normalized;
      const reason = {
        code: "herdr_failed" as const,
        message: normalized.message,
      };
      try {
        await pause(100, deps, request.snapshot?.sessionId);
        started = await start();
        retry = { reason, result: "success" };
      } catch (retryError) {
        throw copyDelegateError(normalizeError(retryError), {
          retry: { reason, result: "failed" },
        });
      }
    }
  } catch (error) {
    const normalized = normalizeError(error);
    if (normalized.code !== "agent_blocked") throw normalized;
    blocked = normalized;
  }
  started = await acceptClaudeTrust(request, {
    name,
    paneId,
    started,
    deadline,
    deps,
  });
  if (
    started != null && request.invocation.agent === "codex" && request.resident
  ) {
    // 코덱스는 첫 turn 전 /rename도 이름 색인에 남겨 재개 때 상주 여부를 읽을 수 있다.
    await submitCodexTitle(
      name,
      sessionTitle({ ...request, callerId }),
      cwd,
      deps,
      request.snapshot?.sessionId,
    );
  }
  if (started == null) {
    throw new DelegateError(
      "agent_blocked",
      `${
        blocked?.message ?? "폴더 신뢰 수락 뒤 입력창이 나타나지 않았습니다"
      }; agent start가 완료되지 않아 prompt를 제출하지 않았습니다`,
      undefined,
      blocked?.sessionId,
      blocked?.retry,
    );
  }
  return {
    live: mergeReportedLive({
      paneId,
      name,
      kind: request.invocation.agent,
      cwd,
      status: "unknown",
    }, started) as ManagedPane,
    retry,
  };
}

// 영어 문구·❯ 포커스·두 선택지에 의존하는 우회로, 공개 신뢰 건너뛰기 플래그가 생기면 제거한다.
// 문구·화면 형식 변경이나 수락 실패는 기존 agent_blocked로 돌아가며, 포함된 화면으로 진단한다.
// 시작 성공 보고에도 화면을 확인한다. 좁은 pane에서는 신뢰 문구가 줄바꿈돼 Herdr가 차단 대신 idle을 보고한다.
async function acceptClaudeTrust(
  request: HerdrPrompt,
  { name, paneId, started, deadline, deps }: {
    name: string;
    paneId: string;
    started?: LiveAgent;
    deadline: number;
    deps: HerdrDeps;
  },
): Promise<LiveAgent | undefined> {
  if (request.invocation.agent !== "claude") return started;
  const cwd = request.snapshot?.cwd ?? request.cwd;
  const sessionId = request.snapshot?.sessionId;
  const read = async () => {
    ensureTime(deadline, deps, sessionId);
    const screen = await deps.exec(deps.env.HERDR_BIN_PATH ?? "herdr", [
      "pane",
      "read",
      paneId,
      "--source",
      "visible",
    ], { cwd, env: deps.env, signal: executionSignal(deps) });
    ensureTime(deadline, deps, sessionId);
    return screen.code === 0 ? screen.stdout : undefined;
  };
  let keys: string[] | undefined;
  try {
    const screen = await read();
    keys = screen == null ? undefined : claudeTrustKeys(screen);
  } catch {
    ensureTime(deadline, deps, sessionId);
  }
  if (keys == null) return started;
  try {
    await json(cwd, deps, ["agent", "send-keys", name, ...keys]);
    ensureTime(deadline, deps, sessionId);
    const accepted = agentFromResult(
      await json(cwd, deps, [
        "agent",
        "wait",
        name,
        "--until",
        "idle",
        "--timeout",
        activityGateTimeout(deadline, deps),
      ]),
      name,
    );
    ensureTime(deadline, deps, sessionId);
    if (accepted.status !== "idle") return;
    // Herdr는 입력창이 그려지기 전에 idle을 보고하며, 그 사이 제출한 prompt는 사라진다.
    const readyDeadline = Math.min(deadline, deps.now() + activityGateMs);
    while (remaining(readyDeadline, deps) > 0) {
      const screen = await read();
      if (
        screen != null && claudeTrustKeys(screen) == null &&
        screen.split("\n").some((line) => line.trim() === "❯")
      ) return accepted;
      await pause(
        Math.min(100, remaining(readyDeadline, deps)),
        deps,
        sessionId,
      );
    }
  } catch {
    // 호출자 중단·전체 기한은 재전파하고, 허더 호출 실패는 시작 차단으로 남긴다.
    ensureTime(deadline, deps, sessionId);
  }
}

async function waitForNativeSession(
  request: HerdrPrompt,
  initialLive: LiveAgent,
  knownSessionId: string | undefined,
  deadline: number,
  deps: HerdrDeps,
): Promise<SharedSession> {
  ensureTime(deadline, deps, knownSessionId);
  const pollDeadline = Math.min(deadline, deps.now() + identityPollMs);
  let live = initialLive;
  let reportedSessionId: string | undefined;
  while (remaining(pollDeadline, deps) > 0) {
    ensureTime(deadline, deps, reportedSessionId ?? knownSessionId);
    if (live.sessionId == null) {
      live = await withSessionError(
        getAgent(
          live,
          request.snapshot?.cwd ?? request.cwd,
          deps,
          knownSessionId,
        ),
        knownSessionId,
      );
    }
    reportedSessionId = readReportedSessionId(live, knownSessionId);
    const candidateSessionId = reportedSessionId ?? knownSessionId;
    if (candidateSessionId != null) {
      try {
        const snapshot = await findNativeSession(candidateSessionId, deps.env);
        if (
          snapshot.agent !== request.invocation.agent ||
          snapshot.cwd !== (request.snapshot?.cwd ?? request.cwd)
        ) {
          throw new DelegateError(
            "invalid_native_session",
            "Herdr session 정보와 native session metadata가 다릅니다",
            undefined,
            candidateSessionId,
          );
        }
        return snapshot;
      } catch (error) {
        if (
          !(error instanceof DelegateError &&
            error.code === "session_not_found")
        ) throw error;
      }
    }
    await pause(
      Math.min(250, remaining(pollDeadline, deps)),
      deps,
      reportedSessionId ?? knownSessionId,
    );
  }
  ensureTime(deadline, deps, reportedSessionId ?? knownSessionId);
  const candidateSessionId = reportedSessionId ?? knownSessionId;
  if (candidateSessionId == null) {
    throw new RetainPaneError(
      "session_id_unavailable",
      "Herdr가 native session ID를 보고하지 않았습니다. 코덱스 훅이 미설치·구버전일 수 있으니 herdr integration status로 확인하고, 해당하면 herdr integration install codex 실행. 새로 설치했다면 새 코덱스 화면의 훅 신뢰 확인을 해소. 보존된 pane은 요청을 재제출하지 말고 화면부터 확인",
    );
  }
  throw new RetainPaneError(
    "invalid_native_session",
    `native session을 찾을 수 없습니다: ${candidateSessionId}`,
    undefined,
    candidateSessionId,
  );
}

function readReportedSessionId(
  live: LiveAgent,
  knownSessionId: string | undefined,
): string | undefined {
  if (live.sessionId == null) return undefined;
  if (live.sessionKind !== "id" || !sessionIdPattern.test(live.sessionId)) {
    throw new DelegateError(
      "invalid_native_session",
      "Herdr가 올바른 native session ID를 보고하지 않았습니다",
      undefined,
      knownSessionId,
    );
  }
  if (
    knownSessionId != null &&
    live.sessionId.toLowerCase() !== knownSessionId.toLowerCase()
  ) {
    throw new DelegateError(
      "session_id_changed",
      `session ID 변경: ${knownSessionId} -> ${live.sessionId}`,
      undefined,
      knownSessionId,
    );
  }
  return live.sessionId;
}

async function waitForNewTurn(
  initial: SharedSession,
  before: NativeCursor | undefined,
  deadline: number,
  deps: HerdrDeps,
): Promise<SharedSession> {
  if (before == null) return initial;
  let snapshot = initial;
  while (true) {
    ensureTime(deadline, deps, snapshot.sessionId);
    const offset = before.path === snapshot.cursor.path &&
        before.identity === snapshot.cursor.identity
      ? before.byteLength
      : 0;
    if (snapshot.turns.some((turn) => turn.start >= offset)) return snapshot;
    await pause(
      Math.min(250, remaining(deadline, deps)),
      deps,
      snapshot.sessionId,
    );
    snapshot = await refreshNativeSession(snapshot);
  }
}

async function waitForQuiescence(
  initial: SharedSession,
  live: LiveAgent,
  deadline: number,
  deps: HerdrDeps,
): Promise<{ snapshot: SharedSession; live: LiveAgent }> {
  let snapshot = initial;
  while (true) {
    ensureTime(deadline, deps, snapshot.sessionId);
    let waited: HerdrResult;
    try {
      waited = await withSessionError(
        json(snapshot.cwd, deps, [
          "agent",
          "wait",
          live.name,
          "--until",
          "idle",
          "--until",
          "done",
          "--until",
          "blocked",
          "--timeout",
          String(Math.max(1, Math.floor(remaining(deadline, deps)))),
        ]),
        snapshot.sessionId,
      );
    } catch (error) {
      if (
        error instanceof DelegateError &&
        (error.code === "cancelled" || error.code === "timeout")
      ) throw error;
      let recovered: LiveAgent | undefined;
      try {
        recovered = await findLiveAgent(snapshot, deps);
      } catch (recoveryError) {
        if (recoveryError instanceof LiveAgentListError) throw error;
        throw recoveryError;
      }
      if (recovered == null) throw error;
      live = recovered;
      continue;
    }
    const candidate = agentFromResult(waited, live.name);
    readReportedSessionId(candidate, snapshot.sessionId);
    if (candidate.status === "blocked") {
      throw new DelegateError(
        "agent_blocked",
        "에이전트가 사용자 입력을 기다립니다",
        undefined,
        snapshot.sessionId,
      );
    }
    if (!["idle", "done"].includes(candidate.status)) {
      await pause(
        Math.min(50, remaining(deadline, deps)),
        deps,
        snapshot.sessionId,
      );
      continue;
    }
    snapshot = await refreshNativeSession(snapshot);
    ensureTime(deadline, deps, snapshot.sessionId);
    const sequence = requireSequence(candidate);
    const cursor = snapshot.cursor;
    await pause(
      Math.min(500, remaining(deadline, deps)),
      deps,
      snapshot.sessionId,
    );
    ensureTime(deadline, deps, snapshot.sessionId);
    const checked = await withSessionError(
      getAgent(live, snapshot.cwd, deps, snapshot.sessionId),
      snapshot.sessionId,
    );
    if (checked.status === "blocked") {
      throw new DelegateError(
        "agent_blocked",
        "에이전트가 사용자 입력을 기다립니다",
        undefined,
        snapshot.sessionId,
      );
    }
    const refreshed = await refreshNativeSession(snapshot);
    ensureTime(deadline, deps, refreshed.sessionId);
    const settled = ["idle", "done"].includes(checked.status) &&
      requireSequence(checked) === sequence &&
      cursorEquals(cursor, refreshed.cursor) && !refreshed.cursor.partial;
    snapshot = refreshed;
    if (!settled) continue;
    if (!turnPending(refreshed)) {
      return { snapshot: refreshed, live: checked };
    }
    // working 대기는 확인과 등록 사이에 끝난 응답을 놓치므로 기록을 다시 확인한다.
    await pause(
      Math.min(1000, remaining(deadline, deps)),
      deps,
      snapshot.sessionId,
    );
  }
}

// 입력 대기 화면이어도 끝나지 않은 요청이 있다.
// 클로드는 백그라운드 작업 완료 알림이 다음 응답을 시작한다. 사용자 중단은
// 종료 기록을 남기지 않아 백그라운드 작업만 기다린다.
// 코덱스는 /side 갈래 대화가 끝나면 본 요청이 진행 중이어도 쉬는 화면이 된다.
function turnPending(snapshot: SharedSession): boolean {
  const turn = snapshot.turns.at(-1);
  if (turn == null) return false;
  if (snapshot.agent === "claude") return turn.background === true;
  return !turn.completed && !turn.aborted;
}

async function findLiveAgent(
  snapshot: SharedSession,
  deps: HerdrDeps,
): Promise<LiveAgent | undefined> {
  let result: HerdrResult;
  try {
    result = await json(snapshot.cwd, deps, ["agent", "list"]);
  } catch (error) {
    if (
      error instanceof DelegateError &&
      (error.code === "cancelled" || error.code === "timeout")
    ) {
      throw new DelegateError(
        error.code,
        error.message,
        error.pane,
        snapshot.sessionId,
      );
    }
    throw new LiveAgentListError(
      "live_session_ambiguous",
      error instanceof Error ? error.message : String(error),
    );
  }
  const agents = arrayObjects(result.agents);
  const bySession = agents.filter((agent) =>
    sessionOf(agent)?.toLowerCase() === snapshot.sessionId.toLowerCase()
  );
  const byName = agents.filter((agent) =>
    isSessionAgentName(nameOf(agent), snapshot.sessionId)
  );
  const candidates = uniqueObjects([...bySession, ...byName]);
  if (candidates.length === 0) return undefined;
  if (candidates.length !== 1) {
    throw new DelegateError(
      "live_session_ambiguous",
      `live agent 후보 복수: ${snapshot.sessionId}`,
    );
  }
  const live = liveFrom(candidates[0]!);
  readReportedSessionId(live, snapshot.sessionId);
  if (live.kind != null && live.kind !== snapshot.agent) {
    throw new DelegateError("live_session_ambiguous", "live agent 종류 불일치");
  }
  if (live.cwd != null && live.cwd !== snapshot.cwd) {
    throw new DelegateError("live_session_ambiguous", "live agent cwd 불일치");
  }
  return live;
}

async function getAgent(
  live: LiveAgent,
  cwd: string,
  deps: HerdrDeps,
  knownSessionId: string | undefined,
): Promise<LiveAgent> {
  const result = await json(cwd, deps, ["agent", "get", live.name]);
  const reported = agentFromResult(result, live.name);
  readReportedSessionId(reported, knownSessionId);
  return mergeReportedLive(live, reported);
}

function agentFromResult(result: HerdrResult, fallbackName: string): LiveAgent {
  const nested = objectValue(result.agent);
  return liveFrom(
    Object.keys(nested).length === 0 ? result : nested,
    fallbackName,
  );
}

// 상주 세션은 close 전까지 남으므로 호출자 워크스페이스에 쌓이지 않게 현재 워크스페이스 바로 다음의 새 워크스페이스에 띄운다.
// 종속 세션은 호출자 워크스페이스에서 같은 호출자의 종속 세션이 가장 많은 탭을 분할하고, 없으면 새 탭에 띄운다.
// 탭·워크스페이스 이름은 사용자가 바꿀 수 있어 Herdr 에이전트 이름의 호출자 표시로 찾고, 비면 마지막 pane을 닫을 때 Herdr가 지운다.
async function allocatePane(
  request: HerdrPrompt,
  cwd: string,
  callerId: string,
  deps: HerdrDeps,
  allocated: (paneId: string) => void,
): Promise<string> {
  if (request.resident) {
    const caller = isBackgroundSession(deps.env)
      ? await onlyCallerPane(await listAgents(cwd, deps), callerId, cwd, deps)
      : await currentPane(cwd, deps);
    return await createWorkspaceAfter(workspaceOf(caller), cwd, deps, {
      label: sessionTitle({ ...request, callerId }),
      allocated,
    });
  }
  const paneId = await openPaneInCallerWorkspace(cwd, callerId, deps);
  allocated(paneId);
  return paneId;
}

async function openPaneInCallerWorkspace(
  cwd: string,
  callerId: string,
  deps: HerdrDeps,
): Promise<string> {
  const caller = await locateCaller(cwd, callerId, deps);
  const anchor = siblingPaneInBusiestTab(caller.workspaceId, caller.agents);
  if (anchor == null) {
    return rootPaneOf(
      await json(cwd, deps, [
        "tab",
        "create",
        "--workspace",
        caller.workspaceId,
        "--cwd",
        cwd,
        "--label",
        callerId,
        "--no-focus",
      ]),
    );
  }
  const split = await json(cwd, deps, [
    "pane",
    "split",
    "--pane",
    anchor,
    "--direction",
    "right",
    "--cwd",
    cwd,
    "--no-focus",
  ]);
  const paneId = stringValue(objectValue(split.pane).pane_id);
  if (paneId == null) {
    throw new DelegateError("herdr_failed", "pane 분할 응답이 불완전합니다");
  }
  return paneId;
}

// Herdr는 새 워크스페이스를 맨 끝에 만들고 0.9.3 CLI로는 옮길 수 없어 소켓의 workspace.move를 쓴다.
// 이동이 실패하거나 중단돼도 기존 정리가 pane을 닫도록 이동 전에 알린다.
async function createWorkspaceAfter(
  workspaceId: string,
  cwd: string,
  deps: HerdrDeps,
  options: { label: string; allocated: (paneId: string) => void },
): Promise<string> {
  const anchor = objectValue(
    (await json(cwd, deps, ["workspace", "get", workspaceId])).workspace,
  );
  const created = await json(cwd, deps, [
    "workspace",
    "create",
    "--cwd",
    cwd,
    "--label",
    options.label,
    "--no-focus",
  ]);
  const paneId = rootPaneOf(created);
  options.allocated(paneId);
  // number는 1부터 세므로 그대로 바로 다음 삽입 위치다.
  await socketRequest(deps, "workspace.move", {
    workspace_id: objectValue(created.workspace).workspace_id,
    insert_index: anchor.number,
  });
  return paneId;
}

function rootPaneOf(created: HerdrResult): string {
  const paneId = stringValue(objectValue(created.root_pane).pane_id);
  if (paneId == null) {
    throw new DelegateError(
      "herdr_failed",
      "Herdr 탭·워크스페이스 생성 응답이 불완전합니다",
    );
  }
  return paneId;
}

// pane 수가 같은 탭끼리는 어느 탭이든 상관없다.
function siblingPaneInBusiestTab(
  workspaceId: string,
  siblings: LiveAgent[],
): string | undefined {
  const byTab = Map.groupBy(
    siblings.filter((sibling) =>
      sibling.workspaceId === workspaceId && sibling.tabId != null &&
      sibling.paneId != null
    ),
    (sibling) => sibling.tabId,
  );
  const busiest = [...byTab.values()].reduce<LiveAgent[]>(
    (most, panes) => panes.length > most.length ? panes : most,
    [],
  );
  return busiest.at(-1)?.paneId;
}

// 세션 ID가 아닌 호출자는 에이전트 이름에 표시하지 않아 분할할 탭을 찾지 않는다.
async function locateCaller(
  cwd: string,
  callerId: string,
  deps: HerdrDeps,
): Promise<{ workspaceId: string; agents: LiveAgent[] }> {
  const current = isBackgroundSession(deps.env)
    ? undefined
    : await currentPane(cwd, deps);
  if (current != null && !sessionIdPattern.test(callerId)) {
    return { workspaceId: workspaceOf(current), agents: [] };
  }
  const agents = await listAgents(cwd, deps);
  const caller = current != null &&
      sessionOf(current)?.toLowerCase() === callerId.toLowerCase()
    ? current
    : await onlyCallerPane(agents, callerId, cwd, deps);
  const workspaceId = workspaceOf(caller);
  const live = agents.map((agent) => liveFrom(agent));
  const marks = await callerMarks(callerId, live, workspaceId, deps.env);
  const siblings = live.filter((agent) =>
    marks.includes(callerOfAgentName(agent.name) ?? "")
  );
  return { workspaceId, agents: siblings };
}

// 백그라운드로 이어진 세션은 이어 오기 전 ID로 띄운 자식도 같은 호출자로 모은다.
async function callerMarks(
  callerId: string,
  agents: LiveAgent[],
  workspaceId: string,
  env: Record<string, string>,
): Promise<string[]> {
  const own = callerMark(callerId);
  if (own == null) return [];
  if (!isBackgroundSession(env)) return [own];
  const others = new Set(agents.flatMap((agent) => {
    const mark = agent.workspaceId === workspaceId
      ? callerOfAgentName(agent.name)
      : undefined;
    return mark == null || mark === own ? [] : [mark];
  }));
  return [own, ...await sessionsContinuedInto(callerId, [...others], env)];
}

// 클로드 백그라운드 세션은 데몬을 처음 띄운 pane의 HERDR_* 환경 변수를 물려받아 현재 pane을 믿을 수 없다.
// 프로세스의 CLAUDE_CODE_SESSION_KIND=bg는 도구 셸에 전달되지 않아 작업마다 주는 CLAUDE_JOB_DIR로 판정한다.
function isBackgroundSession(env: Record<string, string>): boolean {
  return (env.CLAUDE_JOB_DIR ?? "") !== "";
}

async function listAgents(
  cwd: string,
  deps: HerdrDeps,
): Promise<Record<string, unknown>[]> {
  return arrayObjects((await json(cwd, deps, ["agent", "list"])).agents);
}

async function onlyCallerPane(
  agents: Record<string, unknown>[],
  callerId: string,
  cwd: string,
  deps: HerdrDeps,
): Promise<Record<string, unknown>> {
  const callerPanes = agents.filter((agent) =>
    sessionOf(agent)?.toLowerCase() === callerId.toLowerCase()
  );
  if (callerPanes.length > 1) {
    throw new DelegateError(
      "live_session_ambiguous",
      `현재 session의 Herdr pane이 복수입니다: ${callerId}`,
    );
  }
  if (callerPanes.length === 1) return callerPanes[0]!;
  const attached = await panesAttachedToJob(agents, cwd, deps);
  if (attached.length === 1) return attached[0]!;
  const continued = await panesContinuedInto(callerId, agents, deps.env);
  if (continued.length === 1) return continued[0]!;
  throw new DelegateError(
    "caller_session_unavailable",
    callerPaneUnavailable(callerId, agents),
  );
}

// 클로드 attach 화면은 Herdr에 세션을 보고하지 않아 세션을 모르는 클로드 pane만 붙인 작업 ID로 확인한다.
async function panesAttachedToJob(
  agents: Record<string, unknown>[],
  cwd: string,
  deps: HerdrDeps,
): Promise<Record<string, unknown>[]> {
  const jobDir = deps.env.CLAUDE_JOB_DIR ?? "";
  if (jobDir === "") return [];
  const jobId = basename(jobDir);
  const attached: Record<string, unknown>[] = [];
  for (const agent of agents) {
    const { kind, name, paneId } = liveFrom(agent);
    if (
      kind !== "claude" || paneId == null || sessionOf(agent) != null ||
      isDelegatedName(name)
    ) continue;
    const info = objectValue(
      (await json(cwd, deps, ["pane", "process-info", "--pane", paneId]))
        .process_info,
    );
    if (
      arrayObjects(info.foreground_processes).some((process) =>
        attachesTo(process, jobId)
      )
    ) attached.push(agent);
  }
  return attached;
}

// 백그라운드로 이어진 세션은 새 ID를 받아도 Herdr가 표시 중인 pane에 이전 ID를 보고할 수 있다.
// 여러 pane이 닿으면 어느 쪽이 이 세션을 표시하는지 알 수 없어 고르지 않는다.
async function panesContinuedInto(
  callerId: string,
  agents: Record<string, unknown>[],
  env: Record<string, string>,
): Promise<Record<string, unknown>[]> {
  const candidates = callerCandidates(agents);
  const origins = await sessionsContinuedInto(
    callerId,
    candidates.map((agent) => sessionOf(agent)!),
    env,
  );
  return candidates.filter((agent) => origins.includes(sessionOf(agent)!));
}

function attachesTo(process: Record<string, unknown>, jobId: string): boolean {
  const argv = Array.isArray(process.argv) ? process.argv : [];
  const index = argv.indexOf("attach");
  return index >= 0 && argv[index + 1] === jobId;
}

function callerPaneUnavailable(
  callerId: string,
  agents: Record<string, unknown>[],
): string {
  const candidates = callerCandidates(agents).map((agent) => {
    const live = liveFrom(agent);
    const title = stringValue(agent.terminal_title_stripped);
    return `- ${live.paneId} session=${live.sessionId} cwd=${live.cwd}${
      title == null ? "" : ` title=${title}`
    }`;
  });
  return [
    `현재 session의 Herdr pane을 찾을 수 없습니다: ${callerId}`,
    "이 session을 표시하는 pane이 후보에 있으면 --caller-id <session ID>로 지정합니다.",
    "이 우회가 필요했다면 유저에게 delegate 스킬·도구 개선을 문의합니다.",
    "후보 pane:",
    ...(candidates.length === 0 ? ["- 없음"] : candidates),
  ].join("\n");
}

async function currentPane(
  cwd: string,
  deps: HerdrDeps,
): Promise<Record<string, unknown>> {
  try {
    return objectValue(
      (await json(cwd, deps, ["pane", "current", "--current"])).pane,
    );
  } catch (error) {
    if (error instanceof DelegateError && error.code === "herdr_failed") {
      throw new DelegateError("transport_unavailable", error.message);
    }
    throw error;
  }
}

function workspaceOf(pane: Record<string, unknown>): string {
  const workspaceId = liveFrom(pane).workspaceId;
  if (workspaceId == null) {
    throw new DelegateError("herdr_failed", "현재 Herdr pane 정보가 없습니다");
  }
  return workspaceId;
}

async function cleanupOwnedPane(
  ownership: OwnedPaneId,
  cwd: string,
  deadline: number,
  deps: HerdrDeps,
): Promise<void> {
  if (ownership == null) return;
  ensureTime(deadline, deps);
  await closePane(ownership, cwd, deps);
}

async function recoverOwnedPane(
  ownership: OwnedPaneId,
  cwd: string,
  deps: HerdrDeps,
): Promise<void> {
  if (ownership == null) return;
  const recoveryDeps: HerdrDeps = {
    exec: deps.exec,
    env: deps.env,
    signal: AbortSignal.timeout(recoveryMs),
    now: deps.now,
    sleep: deps.sleep,
  };
  await cleanupOwnedPane(
    ownership,
    cwd,
    recoveryDeps.now() + recoveryMs,
    recoveryDeps,
  );
}

async function cleanupAutomatically(
  live: LiveAgent,
  snapshot: SharedSession,
  deadline: number,
  deps: HerdrDeps,
): Promise<DelegateWarning[] | undefined> {
  // 상주 세션은 Herdr에서 계속 보이도록 close로만 정리한다.
  if (isResidentName(live.name)) return undefined;
  if (live.paneId == null) {
    return [{
      code: "cleanup_failed",
      message: "live pane 위치를 확인하지 못했습니다",
    }];
  }
  const { paneId } = live;
  try {
    return await withPaneLock(
      { deadline, deps, sessionId: live.sessionId },
      async () => {
        await closeSessionPane(paneId, snapshot, { deadline, deps });
        return undefined;
      },
    );
  } catch (error) {
    const normalized = normalizeError(error);
    if (isLifecycleError(normalized)) throw normalized;
    return [{
      code: "cleanup_failed",
      message: normalized.message,
    }];
  }
}

async function renameCodex(
  live: LiveAgent,
  title: string,
  cwd: string,
  deps: HerdrDeps,
): Promise<void> {
  if (title === "") return;
  try {
    await submitCodexTitle(live.name, title, cwd, deps, live.sessionId);
  } catch (error) {
    const normalized = normalizeError(error);
    if (isLifecycleError(normalized)) throw normalized;
    // Codex local command는 best effort이며 공개 warning을 만들지 않는다.
  }
}

async function submitCodexTitle(
  name: string,
  title: string,
  cwd: string,
  deps: HerdrDeps,
  sessionId?: string,
): Promise<void> {
  await json(cwd, deps, ["agent", "prompt", name, `/rename ${title}`]);
  await pause(500, deps, sessionId);
}

async function resolveCallerId(
  explicit: string | undefined,
  deps: HerdrDeps,
  cwd: string,
  strict = false,
): Promise<string | undefined> {
  const known = explicit || callerSessionId(deps.env);
  if (known != null) return known;
  try {
    const pane = objectValue(
      (await json(cwd, deps, ["pane", "current", "--current"])).pane,
    );
    return stringValue(objectValue(pane.agent_session).value);
  } catch (error) {
    if (
      error instanceof DelegateError &&
      (error.code === "cancelled" || error.code === "timeout")
    ) throw error;
    if (strict) {
      throw new DelegateError(
        "transport_unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
    return undefined;
  }
}

async function closeSessionPane(
  paneId: string,
  snapshot: SharedSession,
  options: { deadline: number; deps: HerdrDeps },
) {
  const { deadline, deps } = options;
  try {
    await closePane(paneId, snapshot.cwd, deps);
    return;
  } catch (error) {
    if (
      !(error instanceof DelegateError) || error.code !== "cleanup_failed" ||
      error.message !== `pane ${paneId} not found`
    ) throw error;
  }
  ensureTime(deadline, deps, snapshot.sessionId);
  const live = await findLiveAgent(snapshot, deps);
  ensureTime(deadline, deps, snapshot.sessionId);
  if (live == null) return;
  if (live.paneId == null) {
    throw new DelegateError(
      "cleanup_failed",
      "live pane 위치를 확인하지 못했습니다",
    );
  }
  await closePane(live.paneId, snapshot.cwd, deps);
}

async function closePane(paneId: string, cwd: string, deps: HerdrDeps) {
  try {
    await json(cwd, deps, ["pane", "close", paneId]);
  } catch (error) {
    const normalized = normalizeError(error);
    if (isLifecycleError(normalized)) throw normalized;
    throw new DelegateError(
      "cleanup_failed",
      normalized.message,
    );
  }
}

async function json(
  cwd: string,
  deps: HerdrDeps,
  args: string[],
  signal = executionSignal(deps),
): Promise<HerdrResult> {
  const before = interruptionError(deps);
  if (before != null) throw before;
  let output: ExecResult;
  try {
    output = await deps.exec(deps.env.HERDR_BIN_PATH ?? "herdr", args, {
      cwd,
      env: deps.env,
      signal,
    });
  } catch (error) {
    const interruption = interruptionError(deps);
    if (interruption != null) throw interruption;
    throw new DelegateError(
      "herdr_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
  const interruption = interruptionError(deps);
  if (interruption != null) throw interruption;
  if (output.code !== 0) {
    const parsed = parseCommandError(output.stderr);
    const starting = args[0] === "agent" && args[1] === "start";
    if (parsed.code === "timeout" && !starting) {
      throw new DelegateError("timeout", parsed.message);
    }
    if (
      parsed.code === "agent_prompt_stalled" && args[0] === "agent" &&
      args[1] === "prompt"
    ) {
      // Herdr는 입력을 전송한 뒤에도 작업 상태를 관측하지 못할 수 있다.
      throw new RetainPaneError("herdr_failed", parsed.message);
    }
    // 시작 직후 종료는 감지 시점에 따라 시작 실패나 전체 기한 안의 대기 시간 초과로 보고되며, 화면으로 원인을 확인한다.
    if (
      parsed.code === "agent_blocked" ||
      (["agent_not_ready", "agent_start_failed", "timeout"].includes(
        parsed.code,
      ) && starting)
    ) {
      throw new DelegateError("agent_blocked", parsed.message);
    }
    throw new DelegateError("herdr_failed", parsed.message);
  }
  try {
    return objectValue(
      (JSON.parse(output.stdout) as Record<string, unknown>).result,
    );
  } catch {
    throw new DelegateError(
      "herdr_failed",
      "Herdr JSON 응답을 해석할 수 없습니다",
    );
  }
}

// CLI의 소켓 클라이언트와 같은 줄 단위 JSON 요청·응답을 쓴다.
async function socketRequest(
  deps: HerdrDeps,
  method: string,
  params: Record<string, unknown>,
): Promise<HerdrResult> {
  const signal = executionSignal(deps);
  let response: Record<string, unknown>;
  try {
    const conn = await Deno.connect({
      transport: "unix",
      path: deps.env.HERDR_SOCKET_PATH!,
    });
    const lines = conn.readable.pipeThrough(new TextDecoderStream())
      .pipeThrough(new TextLineStream()).getReader();
    const close = () => void lines.cancel();
    signal.addEventListener("abort", close, { once: true });
    try {
      signal.throwIfAborted();
      await conn.write(
        new TextEncoder().encode(
          `${JSON.stringify({ id: `delegate:${method}`, method, params })}\n`,
        ),
      );
      response = objectValue(JSON.parse((await lines.read()).value ?? ""));
    } finally {
      signal.removeEventListener("abort", close);
      await lines.cancel();
    }
  } catch (error) {
    throw interruptionError(deps) ?? new DelegateError(
      "herdr_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (response.error != null) {
    throw new DelegateError(
      "herdr_failed",
      stringValue(objectValue(response.error).message) ?? "Herdr 요청 실패",
    );
  }
  return objectValue(response.result);
}

function parseCommandError(stderr: string): { code: string; message: string } {
  try {
    const error = objectValue(objectValue(JSON.parse(stderr)).error);
    return {
      code: stringValue(error.code) ?? "herdr_failed",
      message: stringValue(error.message) ?? "Herdr 명령 실패",
    };
  } catch {
    return {
      code: "herdr_failed",
      message: stderr.trim() || "Herdr 명령 실패",
    };
  }
}

function document(
  snapshot: SharedSession,
  activity: PublicActivity,
  options: {
    outcome?: PromptOutcome;
    model?: string;
    warnings?: DelegateWarning[];
    retry?: RetryRecord;
  } = {},
): DelegateDocument {
  return {
    session_id: snapshot.sessionId,
    agent: snapshot.agent,
    ...(options.model == null ? {} : { model: options.model }),
    activity,
    ...options.outcome,
    ...(options.warnings == null || options.warnings.length === 0
      ? {}
      : { warnings: options.warnings }),
    ...(options.retry == null ? {} : { retry: options.retry }),
  };
}

function liveFrom(
  value: Record<string, unknown>,
  fallbackName = "",
): LiveAgent {
  const pane = objectValue(value.pane);
  const session = objectValue(value.agent_session);
  const kind = stringValue(value.agent_kind) ?? stringValue(value.kind) ??
    stringValue(value.agent);
  return {
    name: nameOf(value) ?? fallbackName,
    ...(kind === "codex" || kind === "claude" ? { kind } : {}),
    cwd: stringValue(value.cwd),
    status: stringValue(value.agent_status) ?? stringValue(value.status) ??
      "unknown",
    sequence: value.state_change_seq == null
      ? undefined
      : String(value.state_change_seq),
    sessionKind: stringValue(session.kind),
    sessionId: stringValue(session.value),
    workspaceId: stringValue(value.workspace_id) ??
      stringValue(pane.workspace_id),
    tabId: stringValue(value.tab_id) ?? stringValue(pane.tab_id),
    paneId: stringValue(value.pane_id) ?? stringValue(pane.pane_id),
  };
}

function mergeLive(base: LiveAgent, update: LiveAgent): LiveAgent {
  return {
    ...base,
    ...Object.fromEntries(
      Object.entries(update).filter(([, value]) => value !== undefined),
    ),
  };
}

function mergeReportedLive(base: LiveAgent, update: LiveAgent): LiveAgent {
  if (update.name !== base.name) {
    throw new DelegateError(
      "live_session_ambiguous",
      "Herdr 응답의 agent가 전송 대상과 다릅니다",
      undefined,
      base.sessionId,
    );
  }
  return mergeLive(base, update);
}

function nameOf(value: Record<string, unknown>): string | undefined {
  return stringValue(value.name) ?? stringValue(value.agent_name) ??
    stringValue(value.pane_id);
}

function sessionOf(value: Record<string, unknown>): string | undefined {
  return stringValue(objectValue(value.agent_session).value);
}

// Herdr 이름은 32자 제한이라 상주·호출자 표시만큼 session ID를 줄인다.
// 호출자 표시는 같은 호출자의 종속 세션을 한 탭에 모으는 기준이다.
function agentName(
  sessionId: string,
  options: { resident: boolean; callerId?: string },
): string {
  const id = compactId(sessionId);
  if (options.resident) return `dlg-r-${id.slice(0, 26)}`;
  const caller = callerMark(options.callerId);
  return caller == null
    ? `dlg-${id.slice(0, 28)}`
    : `dlg-${caller}-${id.slice(0, 15)}`;
}

// 코덱스는 시작 뒤에야 session ID가 확정되므로 그 전에 시작하는 다른 위임도 같은 탭을 찾도록 호출자를 표시한다.
function temporaryAgentName(callerId: string): string {
  const caller = callerMark(callerId);
  const random = crypto.randomUUID().slice(0, 8);
  return caller == null ? `dlg-tmp-${random}` : `dlg-tmp-${caller}-${random}`;
}

function callerMark(callerId: string | undefined): string | undefined {
  return callerId != null && sessionIdPattern.test(callerId)
    ? compactId(callerId).slice(0, 12)
    : undefined;
}

function callerOfAgentName(name: string): string | undefined {
  return /^dlg-(?:tmp-)?([0-9a-f]{12})-[0-9a-f]+$/.exec(name)?.[1];
}

function compactId(sessionId: string): string {
  return sessionId.replaceAll("-", "").toLowerCase();
}

// 위임으로 띄운 종속 세션은 호출자가 아니므로 후보에서 뺀다.
function callerCandidates(
  agents: Record<string, unknown>[],
): Record<string, unknown>[] {
  return agents.filter((agent) =>
    sessionOf(agent) != null && !isDelegatedName(stringValue(agent.name))
  );
}

function isDelegatedName(name: string | undefined): boolean {
  return name != null && name.startsWith("dlg-") && !isResidentName(name);
}

function isResidentName(name: string): boolean {
  return name.startsWith("dlg-r-");
}

function isSessionAgentName(
  name: string | undefined,
  sessionId: string,
): boolean {
  const shown = /^dlg-(?:r-|[0-9a-f]{12}-)?([0-9a-f]{15,})$/.exec(name ?? "")
    ?.[1];
  return shown != null && compactId(sessionId).startsWith(shown);
}

function hasLiveOptionConflict(request: HerdrPrompt, agent: Agent): boolean {
  return request.startOptionsSpecified ||
    (agent === "claude" && request.name != null);
}

function activityOf(status: string): PublicActivity {
  if (status === "working") return "working";
  if (status === "blocked") return "blocked";
  if (status === "idle" || status === "done") return "quiescent";
  return "unknown";
}

function requireSequence(live: LiveAgent): string {
  if (live.sequence == null) {
    throw new DelegateError(
      "herdr_failed",
      "Herdr state_change_seq가 없습니다",
    );
  }
  return live.sequence;
}

function ensureTime(
  deadline: number,
  deps: HerdrDeps,
  sessionId?: string,
): void {
  const interruption = interruptionError(deps, sessionId);
  if (interruption != null) throw interruption;
  if (remaining(deadline, deps) <= 0) {
    throw new DelegateError(
      "timeout",
      "실행 제한 시간 초과",
      undefined,
      sessionId,
    );
  }
}

function activityGateTimeout(deadline: number, deps: HerdrDeps): string {
  return String(
    Math.max(
      1,
      Math.floor(Math.min(activityGateMs, remaining(deadline, deps))),
    ),
  );
}

function remaining(deadline: number, deps: HerdrDeps): number {
  return deadline - deps.now();
}

async function pause(
  milliseconds: number,
  deps: HerdrDeps,
  sessionId?: string,
): Promise<void> {
  const before = interruptionError(deps, sessionId);
  if (before != null) throw before;
  try {
    await deps.sleep(milliseconds, executionSignal(deps));
  } catch (error) {
    const interruption = interruptionError(deps, sessionId);
    if (interruption != null) throw interruption;
    throw error;
  }
  const interruption = interruptionError(deps, sessionId);
  if (interruption != null) throw interruption;
}

async function withSessionError<T>(
  operation: Promise<T>,
  sessionId?: string,
): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    const normalized = normalizeError(error);
    throw copyDelegateError(normalized, {
      sessionId: normalized.sessionId ?? sessionId,
    });
  }
}

function cancelled(sessionId?: string): DelegateError {
  return new DelegateError(
    "cancelled",
    sessionId == null ? "호출자 중단" : `호출자 중단; session_id=${sessionId}`,
    undefined,
    sessionId,
  );
}

function promptExecutionDeps(
  deps: HerdrDeps,
  timeoutMs: number,
): PromptExecutionDeps {
  const callerSignal = deps.signal;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return {
    ...deps,
    callerSignal,
    timeoutSignal,
    executionSignal: AbortSignal.any([callerSignal, timeoutSignal]),
  };
}

function executionSignal(deps: HerdrDeps): AbortSignal {
  return isPromptExecutionDeps(deps) ? deps.executionSignal : deps.signal;
}

function interruptionError(
  deps: HerdrDeps,
  sessionId?: string,
): DelegateError | undefined {
  if (isPromptExecutionDeps(deps)) {
    if (deps.callerSignal.aborted) return cancelled(sessionId);
    if (deps.timeoutSignal.aborted) {
      return new DelegateError(
        "timeout",
        "실행 제한 시간 초과",
        undefined,
        sessionId,
      );
    }
  } else if (deps.signal.aborted) {
    return cancelled(sessionId);
  }
}

function isPromptExecutionDeps(
  deps: HerdrDeps,
): deps is PromptExecutionDeps {
  return "executionSignal" in deps;
}

function isLifecycleError(error: DelegateError): boolean {
  return error.code === "cancelled" || error.code === "timeout";
}

function objectValue(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

function arrayObjects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(objectValue) : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function uniqueObjects(values: Record<string, unknown>[]) {
  return [...new Set(values)];
}
