import { DelegateError } from "./document.ts";

export type Agent = "codex" | "claude";
export type AgentOption = "auto" | "same" | "other" | Agent;
export type Permission = "read-only" | "write";
export type Transport = "direct" | "herdr";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type PlanRequest = {
  permission: Permission;
  cwd: string;
  addDirs: readonly string[];
  effort?: Effort;
  prompt: string;
  model?: string;
  callerId?: string;
  name?: string;
  resumeSessionId?: string;
};

export type NativeInvocation = {
  agent: Agent;
  directArgs: string[];
  herdrArgs: string[];
  prompt: string;
};

export const delegatePromptPrefix =
  "delegate 스킬 등 다른 에이전트 재위임 금지.\n\n";

export function stripDelegatePromptPrefix(prompt: string): string {
  return prompt.startsWith(delegatePromptPrefix)
    ? prompt.slice(delegatePromptPrefix.length)
    : prompt;
}

export function selectAgent(
  prompt: string,
): { agent: Agent; reason: string } {
  if (/(계획|검토|디버깅|원인|plan|review|debug|root cause)/iu.test(prompt)) {
    return { agent: "codex", reason: "task-kind=analysis" };
  }
  if (
    /(프론트엔드|frontend|front-end).*(구현|수정|implement|change)|(?:구현|수정|implement|change).*(프론트엔드|frontend|front-end)/iu
      .test(prompt)
  ) {
    return { agent: "claude", reason: "task-kind=frontend" };
  }
  if (/(조율|넓은 맥락|coordinate|orchestrat|broad context)/iu.test(prompt)) {
    return { agent: "claude", reason: "task-kind=coordination" };
  }
  return { agent: "codex", reason: "task-kind=default" };
}

/**
 * 명시·호출자 기준 agent. auto는 첫 소속 판정 모델의 agent이며 없으면 생략해
 * 재개 시 감지된 agent, 새 시작 시 키워드 추정에 맡긴다.
 */
export function requestedAgent(
  option: AgentOption,
  models: readonly string[],
  env: Record<string, string>,
): Agent | undefined {
  if (option === "auto") {
    return models.map(modelOwner).find((owner) => owner != null);
  }
  if (option !== "same" && option !== "other") return option;
  const caller = detectCaller(env);
  if (caller == null) {
    throw new DelegateError(
      "usage",
      `--agent ${option}의 호출자를 CODEX_THREAD_ID·CLAUDECODE로 확인할 수 없습니다`,
    );
  }
  if (option === "same") return caller;
  return caller === "codex" ? "claude" : "codex";
}

export function selectModel(
  agent: Agent,
  models: readonly string[],
): string | undefined {
  return models.find((model) => (modelOwner(model) ?? agent) === agent);
}

// detectCaller와 같은 이유로 코덱스를 먼저 본다.
export function callerSessionId(
  env: Record<string, string>,
): string | undefined {
  return env.CODEX_THREAD_ID || env.CLAUDE_CODE_SESSION_ID || undefined;
}

// Herdr 중첩 시 클로드 환경 변수가 자식 코덱스에 상속될 수 있어 코덱스를 먼저 본다.
function detectCaller(env: Record<string, string>): Agent | undefined {
  if ((env.CODEX_THREAD_ID ?? "") !== "") return "codex";
  if (env.CLAUDECODE === "1") return "claude";
  return undefined;
}

function modelOwner(model: string): Agent | undefined {
  if (/^(gpt-|o\d|codex-)/iu.test(model)) return "codex";
  if (/^(claude-|opus|sonnet|haiku|fable)/iu.test(model)) return "claude";
  return undefined;
}

export function parseDuration(input: string): number {
  const match = /^(\d+)(ms|s|m|h)$/.exec(input);
  if (match == null) throw new RangeError(`잘못된 duration: ${input}`);
  const value = Number(match[1]);
  const multiplier = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[
    match[2] as "ms" | "s" | "m" | "h"
  ];
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`잘못된 duration: ${input}`);
  }
  return value * multiplier;
}

export function selectTransport(
  requested: "auto" | Transport,
  env: Record<string, string>,
): { transport: Transport; reason: string } {
  if (requested !== "auto") {
    return { transport: requested, reason: `transport-explicit=${requested}` };
  }
  return env.HERDR_ENV === "1"
    ? { transport: "herdr", reason: "HERDR_ENV=1" }
    : { transport: "direct", reason: "HERDR_ENV!=1" };
}
