import type { NativeInvocation } from "./select.ts";
import type { Exec, ExecResult } from "./process.ts";
import { type DelegateDocument, DelegateError } from "./document.ts";
import {
  continuesNativeSession,
  outcomeAfter,
  refreshNativeSession,
  type SharedSession,
} from "./native_session.ts";

export type DirectDeps = {
  exec: Exec;
  env: Record<string, string>;
  cwd: string;
  signal: AbortSignal;
  onStdout?: (chunk: string) => void | Promise<void>;
};

export type DirectHandle = {
  output: Promise<ExecResult>;
  interrupted: AbortSignal;
  timedOut: AbortSignal;
};

function directEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.startsWith("HERDR_")),
  );
}

export function startDirect(
  invocation: NativeInvocation,
  deps: DirectDeps,
  timeoutMs: number,
): DirectHandle {
  const timedOut = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([deps.signal, timedOut]);
  return {
    output: deps.exec(invocation.agent, invocation.directArgs, {
      cwd: deps.cwd,
      env: directEnv(deps.env),
      stdin: invocation.prompt,
      signal,
      onStdout: deps.onStdout,
    }),
    interrupted: deps.signal,
    timedOut,
  };
}

export function directAbortStatus(
  handle: DirectHandle,
): "cancelled" | "timed_out" | undefined {
  if (handle.interrupted.aborted) return "cancelled";
  if (handle.timedOut.aborted) return "timed_out";
}

export function statusDirect(snapshot: SharedSession): DelegateDocument {
  return {
    session_id: snapshot.sessionId,
    agent: snapshot.agent,
    activity: "unknown",
    observation: snapshot.observation,
  };
}

export function closeDirect(): never {
  throw new DelegateError(
    "transport_unavailable",
    "close는 연결된 Herdr 창만 제어합니다. 직접 실행은 prompt를 실행한 호스트 세션에서 중단하세요",
  );
}

export async function waitDirect(
  snapshot: SharedSession,
  options: {
    timeoutMs: number;
    signal: AbortSignal;
    now(): number;
    sleep(ms: number, signal: AbortSignal): Promise<void>;
  },
): Promise<DelegateDocument> {
  const deadline = options.now() + options.timeoutMs;
  const timedOut = AbortSignal.timeout(options.timeoutMs);
  const signal = AbortSignal.any([options.signal, timedOut]);
  const latest = snapshot.turns.at(-1);
  // 끝난 요청 뒤 부분 기록이 있으면 새 요청일 수 있어 이전 결과를 반환하지 않는다.
  const boundary = {
    offset: latest == null
      ? 0
      : (latest.completed || latest.aborted) && snapshot.cursor.partial
      ? latest.end
      : latest.start,
    excludeInitialTurn: true,
  };
  let current = snapshot;
  try {
    while (true) {
      if (options.signal.aborted) {
        throw new DelegateError("cancelled", "호출자 중단");
      }
      if (timedOut.aborted || options.now() >= deadline) {
        throw new DelegateError(
          "timeout",
          "기록에서 요청 종료를 확인하지 못했습니다",
        );
      }
      const turn = current.turns.filter((turn) => turn.start >= boundary.offset)
        .at(-1);
      if (turn?.aborted) {
        throw new DelegateError("cancelled", "원본 기록의 요청 중단");
      }
      if (turn?.completed && !current.cursor.partial) {
        const outcome = outcomeAfter(current, boundary);
        if (turn.assistant == null) {
          throw new DelegateError(
            "agent_failed",
            "완료 기록에 최종 응답이 없습니다",
          );
        }
        return { ...statusDirect(current), ...outcome };
      }
      await options.sleep(Math.min(250, deadline - options.now()), signal);
      current = await refreshNativeSession(current);
      if (!continuesNativeSession(snapshot, current)) {
        throw new DelegateError(
          "invalid_native_session",
          "대기 중 원본 기록이 교체되거나 줄어 요청 경계를 확인할 수 없습니다",
        );
      }
    }
  } catch (error) {
    if (options.signal.aborted) {
      throw new DelegateError("cancelled", "호출자 중단");
    }
    if (timedOut.aborted) {
      throw new DelegateError(
        "timeout",
        "기록에서 요청 종료를 확인하지 못했습니다",
      );
    }
    throw error;
  }
}
