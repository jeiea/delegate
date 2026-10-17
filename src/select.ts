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
  /** 자식 세션의 셸에 넘길 남은 위임 단계 수 */
  budget: number;
};

export const budgetVariable = "DELEGATE_BUDGET";

/** native 세션 이름 */
export function sessionTitle(
  request: Pick<PlanRequest, "callerId" | "name">,
): string {
  return [
    request.callerId,
    request.name,
  ].filter((part) => part != null && part !== "").join(" ");
}

/** 사람이 연 세션은 값이 없어 구현 위임과 그 검토 위임까지 두 단계를 허용한다 */
export const defaultDelegationBudget = 2;

export function delegationBudget(env: Record<string, string>): number {
  const value = env[budgetVariable];
  if (value == null) return defaultDelegationBudget;
  if (!/^\d+$/.test(value)) {
    throw new DelegateError(
      "usage",
      `${budgetVariable}는 0 이상의 정수여야 합니다: ${value}`,
    );
  }
  return Number(value);
}

export type NativeInvocation = {
  agent: Agent;
  directArgs: string[];
  herdrArgs: string[];
  prompt: string;
};

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
  const match = /^(\d+)(s|m|h)$/.exec(input);
  if (match == null) throw new RangeError(`잘못된 duration: ${input}`);
  const value = Number(match[1]);
  const multiplier = durationUnits[match[2] as keyof typeof durationUnits];
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`잘못된 duration: ${input}`);
  }
  return value * multiplier;
}

export function formatDuration(ms: number): string {
  const [unit, size] = Object.entries(durationUnits).find(([, size]) =>
    ms % size === 0
  )!;
  return `${ms / size}${unit}`;
}

const durationUnits = { h: 3_600_000, m: 60_000, s: 1_000 };

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
