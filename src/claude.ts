import type { ParsedAgentOutput, ParsedSession } from "./codex.ts";
import {
  budgetVariable,
  type NativeInvocation,
  type PlanRequest,
  sessionTitle,
} from "./select.ts";

export function planClaude(request: PlanRequest): NativeInvocation {
  const name = sessionTitle(request);
  const permission = request.permission === "read-only"
    ? [
      "--permission-mode=auto",
      "--tools=Bash,Read,Glob,Grep,WebSearch,WebFetch",
      "--allowedTools=WebSearch,WebFetch(domain:*)",
      "--strict-mcp-config",
    ]
    : [
      "--permission-mode=auto",
      "--allowedTools=WebSearch,WebFetch(domain:*)",
    ];
  const shared = [
    `--settings=${
      JSON.stringify({ env: { [budgetVariable]: String(request.budget) } })
    }`,
    ...(request.model == null ? [] : [`--model=${request.model}`]),
    ...(request.effort == null ? [] : [`--effort=${request.effort}`]),
    ...permission,
    ...request.addDirs.map((dir) => `--add-dir=${dir}`),
    ...(name === "" ? [] : [`--name=${name}`]),
    ...(request.resumeSessionId == null
      ? []
      : [`--resume=${request.resumeSessionId}`]),
  ];

  return {
    agent: "claude",
    directArgs: [
      "-p",
      "--verbose",
      "--output-format=stream-json",
      ...shared,
      "-",
    ],
    herdrArgs: shared,
    prompt: request.prompt,
  };
}

export function parseClaudeEvents(text: string): ParsedAgentOutput {
  let sessionId: string | undefined;
  let result: string | undefined;
  let error: string | undefined;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const event = JSON.parse(line);
      if (event.type !== "result") continue;
      sessionId = event.session_id;
      if (event.subtype === "success" && event.is_error === false) {
        result = event.result;
      } else {
        error = event.result ?? event.subtype ?? "claude_error";
      }
    } catch {
      error = "invalid_jsonl";
    }
  }
  return { sessionId, result, error };
}

export function parseClaudeSession(
  records: readonly { value: unknown; start: number; end: number }[],
): ParsedSession {
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let active:
    | {
      prompt: string;
      start: number;
      inFlight?: boolean;
      groups: Map<
        string,
        { texts: string[]; toolUse: boolean }
      >;
    }
    | undefined;
  let title: string | undefined;
  const turns: ParsedSession["turns"] = [];
  const background = new Set<string>();

  for (const record of records) {
    const event = asObject(record.value);
    const recordSessionId = stringValue(event.sessionId) ??
      stringValue(event.session_id);
    if (
      recordSessionId != null &&
      sessionId != null &&
      recordSessionId !== sessionId
    ) {
      throw new Error("claude session ID changed inside JSONL");
    }
    sessionId ??= stringValue(event.sessionId) ?? stringValue(event.session_id);
    cwd ??= stringValue(event.cwd);
    if (event.type === "custom-title") {
      title = stringValue(event.customTitle) ?? title;
    }
    trackBackground(event, background);
    const prompt = humanPrompt(event);
    if (prompt != null) {
      if (active != null) {
        turns.push({
          prompt: active.prompt,
          completed: false,
          start: active.start,
          end: record.start,
        });
      }
      // 진행 중인 턴에 합쳐진 요청은 앞선 도구 실행이 끝나야 응답한다.
      const merged = event.type === "attachment" && active?.inFlight === true;
      active = {
        prompt,
        start: record.start,
        ...(merged ? { inFlight: true } : {}),
        groups: new Map(),
      };
      continue;
    }
    const inFlight = awaitsReply(event);
    if (active != null && inFlight != null) active.inFlight = inFlight;
    if (
      event.type === "assistant" &&
      active != null &&
      event.isSidechain !== true
    ) {
      const requestId = stringValue(event.requestId) ??
        stringValue(asObject(event.message).id) ??
        `request-${active.groups.size}`;
      let group = active.groups.get(requestId);
      if (group == null) {
        group = { texts: [], toolUse: false };
        active.groups.set(requestId, group);
      }
      for (const blockValue of arrayValue(asObject(event.message).content)) {
        const block = asObject(blockValue);
        if (block.type === "tool_use") group.toolUse = true;
        if (block.type === "text" && typeof block.text === "string") {
          group.texts.push(block.text);
        }
      }
      continue;
    }
    // 백그라운드 작업이 남은 턴은 완료 알림으로 이어지는 응답까지 한 턴으로 본다.
    if (
      event.type === "system" &&
      event.subtype === "turn_duration" &&
      active != null &&
      background.size === 0
    ) {
      const assistant = finalAnswer(active.groups);
      turns.push({
        prompt: active.prompt,
        ...(assistant == null ? {} : { assistant }),
        completed: true,
        start: active.start,
        end: record.end,
      });
      active = undefined;
    }
  }
  if (active != null) {
    // 백그라운드 작업을 기다리며 멈춘 턴의 중간 답변은 호출자가 계속 기다릴지 판단하는 근거다.
    const assistant = background.size === 0
      ? undefined
      : finalAnswer(active.groups);
    turns.push({
      prompt: active.prompt,
      ...(assistant == null ? {} : { assistant }),
      completed: false,
      ...(background.size === 0 ? {} : { background: true }),
      ...(active.inFlight === true ? { inFlight: true } : {}),
      start: active.start,
      end: records.at(-1)?.end ?? active.start,
    });
  }
  return {
    sessionId,
    cwd,
    turns,
    title,
  };
}

function finalAnswer(
  groups: Map<string, { texts: string[]; toolUse: boolean }>,
): string | undefined {
  return [...groups.values()]
    .filter((group) => !group.toolUse && group.texts.length > 0)
    .at(-1)?.texts.join("\n");
}

// 작업을 기다리는 중 받은 후속 요청도 작업이 끝나야 완료된다.
// 시작은 도구 결과, 종료는 status가 있는 task-notification이나 TaskStop 결과로 남는다.
// status 없는 알림은 Monitor 중간 이벤트, persistent Monitor는 세션 내내 유지된다.
function trackBackground(
  event: Record<string, unknown>,
  background: Set<string>,
): void {
  const result = asObject(event.toolUseResult);
  const started = stringValue(result.backgroundTaskId) ??
    (result.persistent === false ? stringValue(result.taskId) : undefined) ??
    (result.isAsync === true ? stringValue(result.agentId) : undefined);
  if (started != null) background.add(started);
  const stopped = result.task_type == null
    ? undefined
    : stringValue(result.task_id);
  if (stopped != null) background.delete(stopped);
  const attachment = asObject(event.attachment);
  const notified = asObject(event.origin).kind === "task-notification"
    ? messageText(asObject(event.message).content)
    : attachment.commandMode === "task-notification"
    ? stringValue(attachment.prompt)
    : undefined;
  // 재개 시 이전 프로세스의 고아 작업은 task-id 여러 개를 묶은 stopped 알림으로 온다.
  if (notified?.includes("<status>") !== true) return;
  for (const [, id] of notified.matchAll(/<task-id>([^<]+)<\/task-id>/g)) {
    background.delete(id!);
  }
}

// 도구 실행이나 도구 결과에 이어질 응답을 기다리면 true, 답변 텍스트나 유저 중단 뒤면 false.
// 유저 중단은 turn_duration 없이 중단 표시만 남긴다. 생각 블록 기록은 판정을 바꾸지 않는다.
function awaitsReply(event: Record<string, unknown>): boolean | undefined {
  if (event.isSidechain === true) return undefined;
  const content = arrayValue(asObject(event.message).content).map(asObject);
  const has = (type: string) => content.some((block) => block.type === type);
  if (event.type === "assistant") {
    if (has("tool_use")) return true;
    return has("text") ? false : undefined;
  }
  if (event.type !== "user") return undefined;
  if (has("tool_result")) return true;
  return messageText(content).startsWith("[Request interrupted by user")
    ? false
    : undefined;
}

// 작업 중 받은 프롬프트는 진행 중인 턴에 합쳐지면 queued_command 첨부로,
// 턴이 끝난 뒤 실행되면 promptSource "queued"인 user 기록으로 남는다.
function humanPrompt(event: Record<string, unknown>): string | undefined {
  if (event.type === "attachment") {
    const attachment = asObject(event.attachment);
    return attachment.type === "queued_command" &&
        asObject(attachment.origin).kind === "human"
      ? stringValue(attachment.prompt)
      : undefined;
  }
  if (event.type !== "user") return undefined;
  const origin = asObject(event.origin);
  const content = asObject(event.message).content;
  if (origin.kind != null || event.promptSource != null) {
    return origin.kind === "human" &&
        (event.promptSource === "typed" || event.promptSource === "queued")
      ? messageText(content)
      : undefined;
  }
  return event.isMeta !== true &&
      event.toolUseResult == null &&
      event.isSidechain !== true &&
      (event.userType == null || event.userType === "external") &&
      typeof content === "string"
    ? content
    : undefined;
}

function asObject(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  return arrayValue(value)
    .flatMap((item) => {
      const block = asObject(item);
      return block.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [];
    })
    .join("\n");
}
