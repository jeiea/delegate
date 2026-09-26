import type { ParsedAgentOutput, ParsedSession } from "./codex.ts";
import {
  delegatePromptPrefix,
  type NativeInvocation,
  type PlanRequest,
} from "./select.ts";

export function planClaude(request: PlanRequest): NativeInvocation {
  const name = [request.callerId, request.name]
    .filter((part) => part != null)
    .join(" ");
  const permission = request.permission === "read-only"
    ? [
      "--permission-mode=dontAsk",
      "--permission-prompts=none",
      "--tools=Bash,Read,Glob,Grep,WebSearch,WebFetch",
      "--allowedTools=WebSearch,WebFetch(domain:*)",
      "--strict-mcp-config",
    ]
    : [
      "--permission-mode=auto",
      "--allowedTools=WebSearch,WebFetch(domain:*)",
    ];
  const shared = [
    "--disallowedTools=Skill(delegate)",
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
    prompt: delegatePromptPrefix + request.prompt,
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
      groups: Map<
        string,
        { texts: string[]; toolUse: boolean; order: number }
      >;
    }
    | undefined;
  let groupOrder = 0;
  const turns: ParsedSession["turns"] = [];

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
    if (isHumanPrompt(event)) {
      active = {
        prompt: messageText(asObject(event.message).content),
        start: record.start,
        groups: new Map(),
      };
      continue;
    }
    if (
      event.type === "assistant" &&
      active != null &&
      event.isSidechain !== true
    ) {
      const requestId = stringValue(event.requestId) ??
        stringValue(asObject(event.message).id) ??
        `request-${groupOrder}`;
      let group = active.groups.get(requestId);
      if (group == null) {
        group = { texts: [], toolUse: false, order: groupOrder++ };
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
    if (
      event.type === "system" &&
      event.subtype === "turn_duration" &&
      active != null
    ) {
      const final = [...active.groups.values()]
        .filter((group) => !group.toolUse && group.texts.length > 0)
        .sort((left, right) => left.order - right.order)
        .at(-1);
      turns.push({
        prompt: active.prompt,
        ...(final == null ? {} : { assistant: final.texts.join("\n") }),
        completed: true,
        start: active.start,
        end: record.end,
      });
      active = undefined;
    }
  }
  if (active != null) {
    turns.push({
      prompt: active.prompt,
      completed: false,
      start: active.start,
      end: records.at(-1)?.end ?? active.start,
    });
  }
  return { sessionId, cwd, turns };
}

function isHumanPrompt(event: Record<string, unknown>): boolean {
  if (event.type !== "user") return false;
  const origin = asObject(event.origin);
  if (origin.kind != null || event.promptSource != null) {
    return origin.kind === "human" && event.promptSource === "typed";
  }
  return (
    event.isMeta !== true &&
    event.toolUseResult == null &&
    event.isSidechain !== true &&
    (event.userType == null || event.userType === "external") &&
    typeof asObject(event.message).content === "string"
  );
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
