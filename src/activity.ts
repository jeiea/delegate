import type { Agent } from "./select.ts";

export type PublicEvent = {
  kind:
    | "session_started"
    | "request_started"
    | "request_completed"
    | "request_aborted"
    | "request_failed"
    | "message"
    | "tool_started"
    | "tool_completed";
  session_id?: string;
  tool?: string;
};

// 공개 필드만 새 객체로 구성해 사고 과정과 도구 입출력의 유출을 막는다.
export function publicEvents(
  agent: Agent,
  value: unknown,
  tools: Map<string, string>,
): PublicEvent[] {
  const event = object(value);
  const payload = object(event.payload);
  if (agent === "codex") {
    if (event.type === "thread.started") {
      return [{ kind: "session_started", session_id: text(event.thread_id) }];
    }
    const type = event.type === "event_msg" ? payload.type : event.type;
    if (type === "turn.started" || type === "task_started") {
      return [{ kind: "request_started" }];
    }
    if (type === "turn.completed" || type === "task_complete") {
      return [{ kind: "request_completed" }];
    }
    if (type === "turn_aborted") return [{ kind: "request_aborted" }];
    if (type === "turn.failed" || type === "error") {
      return [{ kind: "request_failed" }];
    }
    if (event.type === "response_item") {
      if (
        payload.type === "function_call" || payload.type === "custom_tool_call"
      ) {
        const tool = toolName(payload.name);
        if (typeof payload.call_id === "string" && tool != null) {
          tools.set(payload.call_id, tool);
        }
        return [{ kind: "tool_started", tool }];
      }
      if (
        payload.type === "function_call_output" ||
        payload.type === "custom_tool_call_output"
      ) {
        return [{
          kind: "tool_completed",
          tool: tools.get(String(payload.call_id)),
        }];
      }
      if (
        payload.type === "message" && payload.role === "assistant" &&
        payload.phase !== "analysis"
      ) {
        return [{ kind: "message" }];
      }
    }
    if (event.type === "item.started" || event.type === "item.completed") {
      const item = object(event.item);
      if (item.type === "agent_message") return [{ kind: "message" }];
      if (
        ["command_execution", "mcp_tool_call", "web_search", "file_change"]
          .includes(String(item.type))
      ) {
        return [{
          kind: event.type === "item.started"
            ? "tool_started"
            : "tool_completed",
          tool: toolName(item.tool) ?? String(item.type),
        }];
      }
    }
    return [];
  }
  if (event.isSidechain === true) return [];
  if (event.type === "system" && event.subtype === "init") {
    return [{ kind: "session_started", session_id: text(event.session_id) }];
  }
  if (event.type === "system" && event.subtype === "turn_duration") {
    return [{ kind: "request_completed" }];
  }
  if (event.type === "result") {
    return [{
      kind: event.subtype === "success" && event.is_error === false
        ? "request_completed"
        : "request_failed",
    }];
  }
  const content = object(event.message).content;
  if (
    event.type === "user" && typeof content === "string" &&
    event.isMeta !== true && event.toolUseResult == null
  ) {
    return [{ kind: "request_started" }];
  }
  if (!Array.isArray(content)) return [];
  return content.flatMap((value): PublicEvent[] => {
    const block = object(value);
    if (event.type === "assistant" && block.type === "tool_use") {
      const tool = toolName(block.name);
      if (typeof block.id === "string" && tool != null) {
        tools.set(block.id, tool);
      }
      return [{ kind: "tool_started", tool }];
    }
    if (event.type === "user" && block.type === "tool_result") {
      return [{
        kind: "tool_completed",
        tool: tools.get(String(block.tool_use_id)),
      }];
    }
    if (event.type === "assistant" && block.type === "text") {
      return [{ kind: "message" }];
    }
    return [];
  });
}

export function object(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toolName(value: unknown): string | undefined {
  return typeof value === "string" && /^[\w.:-]{1,200}$/.test(value)
    ? value
    : undefined;
}
