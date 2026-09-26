export type Agent = "codex" | "claude";
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
