import { stringify } from "jsr:@std/yaml@1.3.0";
import type { PublicEvent } from "./activity.ts";

export type NativeObservation = {
  request_state: "completed" | "incomplete" | "aborted" | "unknown";
  last_activity_at?: string;
  last_activity?: PublicEvent;
  partial_record: boolean;
};

export type PublicActivity =
  | "working"
  | "blocked"
  | "quiescent"
  | "not_live"
  | "unknown";

export type NativeSessionId = string & {
  readonly __brand: "NativeSessionId";
};

export type PublicErrorCode =
  | "usage"
  | "invalid_session_id"
  | "live_option_conflict"
  | "transport_unavailable"
  | "caller_session_unavailable"
  | "session_not_found"
  | "session_ambiguous"
  | "live_session_ambiguous"
  | "session_id_unavailable"
  | "session_id_changed"
  | "unsafe_native_path"
  | "invalid_native_session"
  | "agent_failed"
  | "herdr_failed"
  | "agent_blocked"
  | "cleanup_failed"
  | "timeout"
  | "cancelled";

export type RetryRecord = {
  reason: {
    code: "herdr_failed";
    message: string;
  };
  result: "success" | "failed";
};

export type DelegateDocument = {
  session_id?: NativeSessionId;
  agent?: "codex" | "claude";
  model?: string;
  activity?: PublicActivity;
  observation?: NativeObservation;
  intervening_prompts?: string[];
  result?: string;
  error?: {
    code: PublicErrorCode;
    message: string;
    pane?: { pane_id: string };
  };
  warnings?: DelegateWarning[];
  retry?: RetryRecord;
  screen?: string;
};

export type DelegateWarning = {
  code: "cleanup_failed";
  message: string;
} | {
  code: "resume_option_ignored";
  message: string;
  agent?: "codex" | "claude";
  model?: string;
};

export class DelegateError extends Error {
  constructor(
    readonly code: PublicErrorCode,
    message: string,
    readonly pane?: { pane_id: string },
    readonly sessionId?: string,
    readonly retry?: RetryRecord,
    readonly screen?: string,
  ) {
    super(message);
  }
}

export function normalizeError(error: unknown): DelegateError {
  if (error instanceof DelegateError) return error;
  return new DelegateError(
    "agent_failed",
    error instanceof Error ? error.message : String(error),
  );
}

export function copyDelegateError(
  error: DelegateError,
  overrides: { sessionId?: string; retry?: RetryRecord },
): DelegateError {
  return new DelegateError(
    error.code,
    error.message,
    error.pane,
    overrides.sessionId ?? error.sessionId,
    overrides.retry ?? error.retry,
    error.screen,
  );
}

export function exitCode(code: PublicErrorCode): number {
  if (
    code === "usage" || code === "invalid_session_id" ||
    code === "live_option_conflict"
  ) return 2;
  if (
    code === "transport_unavailable" ||
    code === "caller_session_unavailable" || code === "session_not_found"
  ) return 3;
  if (code === "agent_blocked") return 4;
  if (code === "timeout") return 6;
  if (code === "cancelled") return 130;
  return 5;
}

export function renderDocument(document: DelegateDocument): string {
  const { result, screen, ...metadata } = document;
  const frontmatter = `---\n${stringify(metadata, { lineWidth: -1 })}---\n`;
  if (screen != null) {
    const longest = Math.max(
      0,
      ...[...screen.matchAll(/`+/g)].map(([run]) => run.length),
    );
    const fence = "`".repeat(Math.max(3, longest + 1));
    return `${frontmatter}\n${fence}text\n${screen}${
      screen.endsWith("\n") ? "" : "\n"
    }${fence}\n`;
  }
  if (result == null) return frontmatter;
  return `${frontmatter}\n${result}${result.endsWith("\n") ? "" : "\n"}`;
}
