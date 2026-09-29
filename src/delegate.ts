import {
  argument,
  choice,
  command,
  integer,
  map,
  message,
  multiple,
  object,
  option,
  optional,
  or,
  string,
  type ValueParser,
  withDefault,
} from "jsr:@optique/core@1.3.0";
import { path, run } from "jsr:@optique/run@1.3.0";
import { resolve } from "jsr:@std/path@1.1.6";
import { parseClaudeEvents, planClaude } from "./claude.ts";
import { parseCodexEvents, planCodex } from "./codex.ts";
import {
  closeDirect,
  directAbortStatus,
  startDirect,
  statusDirect,
  waitDirect,
} from "./direct.ts";
import { publicEvents } from "./activity.ts";
import {
  type DelegateDocument,
  DelegateError,
  exitCode,
  type NativeSessionId,
  normalizeError,
  renderDocument,
} from "./document.ts";
import {
  closeHerdr,
  diagnoseSessionPane,
  type HerdrDeps,
  promptHerdr,
  statusHerdr,
  waitHerdr,
} from "./herdr.ts";
import {
  assertSessionId,
  findNativeSession,
  renderConversation,
  sessionIdPattern,
} from "./native_session.ts";
import { denoExec, type Exec } from "./process.ts";
import {
  type Agent,
  type Effort,
  type NativeInvocation,
  parseDuration,
  type Permission,
  selectAgent,
  selectTransport,
} from "./select.ts";

export type Deps = {
  exec: Exec;
  env: Record<string, string>;
  stdin: { isTerminal(): boolean; text(): Promise<string> };
  cwd: string;
  signal: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  progress?: (text: string) => void | Promise<void>;
};

type PromptOptions = {
  kind: "prompt";
  target?: string;
  promptFile?: string;
  agent: "auto" | Agent;
  transport: "auto" | "herdr" | "direct";
  permission?: Permission;
  model?: string;
  effort?: Effort;
  addDirs: readonly string[];
  callerId?: string;
  name?: string;
  timeoutMs: number;
};

type ParsedCommand = PromptOptions | {
  kind: "status";
  target: string;
} | {
  kind: "wait";
  target: string;
  timeoutMs: number;
  callerId?: string;
  name?: string;
} | {
  kind: "logs";
  target: string;
  lines: number;
} | {
  kind: "close";
  target: string;
};

class CliExit extends Error {
  constructor(readonly code: number) {
    super(`CLI exit ${code}`);
  }
}

const duration: ValueParser<"sync", number> = {
  mode: "sync",
  metavar: "DURATION",
  placeholder: 1_200_000,
  parse(input) {
    try {
      return { success: true, value: parseDuration(input) };
    } catch {
      return { success: false, error: message`잘못된 duration: ${input}` };
    }
  },
  format: (value) => `${value}ms`,
};

function parser() {
  const prompt = map(
    command(
      "prompt",
      object({
        target: optional(argument(string({ metavar: "SESSION_ID" }), {
          description:
            message`후속 prompt를 보낼 native session ID. 종료된 session은 새 pane에서 재개`,
        })),
        promptFile: optional(option(
          "-f",
          "--prompt-file",
          path({ type: "file", mustExist: true }),
          { description: message`prompt 본문 파일. 생략 시 stdin` },
        )),
        agent: withDefault(
          option("--agent", choice(["auto", "codex", "claude"] as const), {
            description:
              message`auto는 prompt 키워드로 추정. 기존 session은 감지된 agent 사용`,
          }),
          "auto" as const,
        ),
        transport: withDefault(
          option("--transport", choice(["auto", "herdr", "direct"] as const), {
            description: message`auto는 HERDR_ENV=1이면 herdr, 아니면 direct`,
          }),
          "auto" as const,
        ),
        permission: optional(option(
          "--permission",
          choice(["read-only", "write"] as const),
          { description: message`기본 write. 실행 중 session은 변경 불가` },
        )),
        model: optional(option("--model", string({ metavar: "MODEL" }), {
          description: message`native agent 모델. 실행 중 session은 변경 불가`,
        })),
        effort: optional(option(
          "--effort",
          choice(["low", "medium", "high", "xhigh", "max"] as const),
          {
            description:
              message`생략 시 native agent 기본값. 실행 중 session은 변경 불가`,
          },
        )),
        addDirs: multiple(option(
          "--add-dir",
          path({ type: "directory", mustExist: true }),
          {
            description:
              message`추가 접근 디렉터리. 실행 중 session은 변경 불가`,
          },
        )),
        callerId: optional(option("--caller-id", string({ metavar: "ID" }), {
          description:
            message`호출자 세션 ID. 관리 탭 이름과 표시 이름 접두사. Codex는 CODEX_THREAD_ID 자동, Claude는 스크래치패드 경로 UUID 전달`,
        })),
        name: optional(option("--name", string({ metavar: "NAME" }), {
          description:
            message`native session 표시 이름. Claude는 새 시작·종료 뒤 재개 시만 적용, Codex는 완료 뒤 /rename`,
        })),
        timeoutMs: withDefault(
          option("--timeout", duration, {
            description: message`시작·대기·자동 정리를 합친 전체 상한`,
          }),
          1_200_000,
        ),
      }),
      {
        brief: message`새 native session 시작 또는 기존 session에 후속 prompt`,
        description:
          message`prompt 완료까지 대기한 뒤 이번 turn의 result를 마크다운 본문으로 반환.

직접 실행은 실제 이벤트 발생 시 표준 오류 JSONL로 transport, agent, 확인된 session_id, kind, 선택적 tool 전달. 도구 인자·결과, 응답 본문·비공개 사고 과정 제외. 주기 알림 없음.

Herdr는 성공하면 관리 pane을 자동 정리하며 마지막 pane 뒤 빈 탭은 Herdr가 제거한다. 대화는 native 기록에 남아 같은 SESSION_ID로 재개 가능. Herdr 작업 중 사람이 직접 prompt를 넣어도 되며 그 turn까지 끝난 뒤 반환하고 추가 prompt는 intervening_prompts에 기록. pane 준비 경합으로 시작이 실패하면 한 번 자동 재시도하고 retry 필드에 기록. retry.result는 시작 회복 여부일 뿐 최종 성공과 무관.`,
        footer: message`error.code 대응

agent_blocked: 사용자 입력 대기. 확인된 error.pane.pane_id와 마크다운 본문의 현재 화면을 보고 차단을 해소. 시작 차단은 prompt 미제출. session_id는 미리 발급된 UUID일 수 있으며 native 기록 파일은 아직 없을 수 있음. 파일이 없다면 원래 prompt를 재제출하기 전에 pane 상태를 확인하고, 필요 시 보존 pane을 명시적으로 정리

invalid_native_session: pane이 확인되면 error.pane.pane_id와 현재 화면을 반환. 차단 해소 뒤에도 native 기록 파일이 없을 수 있으므로 pane을 확인하고 필요 시 정리

live_option_conflict: 실행 중 session에 --permission·--model·--effort·--add-dir 지정

live_session_ambiguous: 같은 session의 다른 재개 진행 중. 완료 뒤 재시도

session_id_unavailable: Herdr가 native session ID를 보고하지 않음. prompt가 전달됐을 수 있으므로 pane을 보존하고 확인된 error.pane.pane_id와 마크다운 본문의 현재 화면을 반환. 재제출 전에 pane을 확인. Codex라면 오류 메시지대로 Herdr 훅 미설치·구버전·신뢰 상태 확인

timeout: --timeout 초과. 확인된 session ID가 있으면 status 확인. 전달 확인 gate timeout 뒤라면 caller ID 라벨의 pane을 직접 확인·정리

warnings[].code 대응 (마크다운 본문은 유효)

cleanup_failed: 정리만 실패. 필요 시 close`,
      },
    ),
    (value) => ({
      kind: "prompt" as const,
      ...value,
    }),
  );
  const status = map(
    command(
      "status",
      object({
        target: argument(string({ metavar: "SESSION_ID" }), {}),
      }),
      {
        brief: message`session activity 조회`,
        description:
          message`추가 진단용. Herdr 창이 있으면 activity: working | blocked(사용자 입력 대기) | quiescent | unknown. 창이 없으면 생존 근거가 없어 unknown, 원본 기록 관찰은 observation에 별도 표시. unknown·출력 부재·미완료 기록만으로 프로세스 종료·실패 단정 금지.

observation 필드

request_state: 최신 요청의 completed(완료) | incomplete(미완료) | aborted(중단) | unknown(요청 없음)

last_activity_at: 완전한 기록 중 마지막 유효 시각. 없으면 생략

last_activity: 마지막으로 해석한 공개 활동 종류와 선택적 도구 이름

partial_record: 끝에 미완성 JSONL 기록 존재 여부

last_activity_at과 last_activity는 서로 다른 기록을 가리킬 수 있음`,
      },
    ),
    (value) => ({ kind: "status" as const, ...value }),
  );
  const wait = map(
    command(
      "wait",
      object({
        target: argument(string({ metavar: "SESSION_ID" }), {}),
        timeoutMs: withDefault(
          option("--timeout", duration, {
            description: message`대기·자동 정리를 합친 전체 상한`,
          }),
          1_200_000,
        ),
        callerId: optional(option("--caller-id", string({ metavar: "ID" }), {
          description: message`Codex --name 지정 시 표시 이름 접두사로 사용`,
        })),
        name: optional(option("--name", string({ metavar: "NAME" }), {
          description:
            message`Codex 전용. prompt가 중단돼 이름을 못 붙였으면 같은 값 재전달`,
        })),
      }),
      {
        brief: message`실행 중 session 완료 대기`,
        description:
          message`호출 연결 유실 뒤 결과 회수용. Herdr 창이 없으면 원본 기록의 최신 요청 종료를 대기. 최신 요청이 이미 완료됐고 부분 기록이 없으면 즉시 결과 반환. 진행·부분 기록 앞의 이전 완료 결과는 반환하지 않으며, 종료 기록이 없으면 제한 시간까지 대기. 생존은 unknown 유지. 대기 시작 뒤 추가된 사람 prompt는 intervening_prompts, 마지막 result는 마크다운 본문으로 반환. Herdr 창이 있으면 성공 후 관리 pane 자동 정리. 오류 의미는 prompt와 동일`,
      },
    ),
    (value) => ({ kind: "wait" as const, ...value }),
  );
  const logs = map(
    command(
      "logs",
      object({
        target: argument(string({ metavar: "SESSION_ID" }), {}),
        lines: withDefault(
          option("--lines", integer({ min: 1 }), {
            description: message`마크다운 본문 마지막 N줄`,
          }),
          200,
        ),
      }),
      {
        brief: message`native 기록의 사람·최종 assistant 대화 렌더`,
        description:
          message`추가 진단용. pane 화면이 아닌 native 기록의 대화와 observation을 반환하므로 pane 종료 뒤에도 사용 가능. observation 필드는 status --help 참조. 도구 인자·결과 전체와 비공개 사고 과정은 제외`,
      },
    ),
    (value) => ({ kind: "logs" as const, ...value }),
  );
  const close = map(
    command(
      "close",
      object({
        target: argument(string({ metavar: "SESSION_ID" }), {}),
      }),
      {
        brief: message`실행 중이면 취소한 뒤 pane 정리`,
        description:
          message`연결된 Herdr 창만 제어. 창이 없으면 transport_unavailable 오류. 직접 실행은 prompt를 실행한 호스트 세션에서 중단. Herdr의 prompt·wait가 자동 정리하지 못했거나 작업을 중단할 때 사용. pane 잠금 대기는 최대 60초이며 초과 시 timeout`,
      },
    ),
    (value) => ({ kind: "close" as const, ...value }),
  );
  return or(prompt, status, wait, logs, close);
}

export async function runDelegate(
  args: string[],
  deps: Deps,
): Promise<{ stdout: string; stderr: string; code: number }> {
  if (args.length === 1 && args[0] === "--skill") {
    const skillUrl = new URL("../SKILL.md", import.meta.url);
    const skill = skillUrl.protocol === "file:"
      ? await Deno.readTextFile(skillUrl)
      : await fetch(skillUrl).then((response) => {
        if (!response.ok) {
          throw new Error(`스킬 파일을 읽지 못했습니다: ${response.status}`);
        }
        return response.text();
      });
    return {
      stdout: skill.replaceAll(
        "{SKILL_BASE_DIR}/src/delegate.ts",
        import.meta.url,
      ),
      stderr: "",
      code: 0,
    };
  }

  let parsed: ParsedCommand;
  const parserStdout: string[] = [];
  const parserStderr: string[] = [];
  try {
    parsed = run(parser(), {
      programName: "delegate",
      brief: message`Codex·Claude native session 위임`,
      description:
        message`--skill은 현재 CLI 주소를 사용한 SKILL.md를 출력. 나머지 명령의 출력은 YAML 프런트매터와 선택적 마크다운 본문. session_id, agent, activity, observation, intervening_prompts, error, warnings, retry는 프런트매터, result는 본문. observation은 logs와 Herdr 창 없는 status·wait의 원본 기록 관찰. intervening_prompts는 추가 사람 프롬프트가 있을 때만 반환`,
      footer:
        message`exit code: 2 usage, 3 환경·session 없음, 4 사용자 조치 필요, 5 실패, 6 timeout, 130 중단`,
      args,
      stdout: (text) => parserStdout.push(text),
      stderr: (text) => parserStderr.push(text),
      onExit: (code) => {
        throw new CliExit(code);
      },
      errorExitCode: 2,
      help: "option",
      colors: false,
      showChoices: true,
      showDefault: true,
    }) as ParsedCommand;
  } catch (error) {
    if (error instanceof CliExit && error.code === 0) {
      return { stdout: parserStdout.join(""), stderr: "", code: 0 };
    }
    return failure(
      new DelegateError(
        "usage",
        parserStderr.join("").trim() ||
          (error instanceof Error ? error.message : String(error)),
      ),
      undefined,
      undefined,
      parserStderr.join(""),
    );
  }

  const herdrDeps = runtimeDeps(deps);
  try {
    if (parsed.kind !== "prompt") {
      const snapshot = await findNativeSession(parsed.target, deps.env);
      if (
        parsed.kind === "wait" && snapshot.agent === "claude" &&
        parsed.name != null
      ) {
        throw new DelegateError(
          "usage",
          "Claude wait에는 --name을 사용할 수 없습니다",
        );
      }
      if (parsed.kind === "logs") {
        return success({
          session_id: snapshot.sessionId,
          agent: snapshot.agent,
          observation: snapshot.observation,
          result: tail(renderConversation(snapshot), parsed.lines),
        });
      }
      if (deps.env.HERDR_ENV !== "1") {
        if (parsed.kind === "status") return success(statusDirect(snapshot));
        if (parsed.kind === "wait") {
          return success(
            await waitDirect(snapshot, {
              ...herdrDeps,
              timeoutMs: parsed.timeoutMs,
            }),
          );
        }
        return closeDirect();
      }
      if (parsed.kind === "status") {
        return success(await statusHerdr(snapshot, herdrDeps));
      }
      if (parsed.kind === "wait") {
        return success(await waitHerdr(snapshot, parsed, herdrDeps));
      }
      return success(await closeHerdr(snapshot, herdrDeps));
    }

    const prompt = await readPrompt(parsed.promptFile, deps);
    if (prompt.trim() === "") {
      throw new DelegateError("usage", "빈 프롬프트입니다");
    }
    // Herdr 환경에서 Herdr 위임이 불가능하면 원인 해소를 최우선으로 한다.
    // direct 전송으로 우회하기 전에 pane·session 연결 문제를 진단하고 복구한다.
    const transport = selectTransport(parsed.transport, deps.env).transport;
    if (transport === "herdr" && deps.env.HERDR_ENV !== "1") {
      throw new DelegateError(
        "transport_unavailable",
        "Herdr 전송을 사용할 수 없습니다",
      );
    }
    const snapshot = parsed.target == null
      ? undefined
      : await findNativeSession(parsed.target, deps.env);
    const agent = selectPromptAgent(parsed.agent, prompt, snapshot?.agent);
    const request = {
      permission: parsed.permission ?? "write",
      cwd: snapshot?.cwd ?? deps.cwd,
      addDirs: parsed.addDirs.map((dir) => resolve(deps.cwd, dir)),
      effort: parsed.effort,
      prompt,
      model: parsed.model,
      callerId: parsed.callerId ?? deps.env.CODEX_THREAD_ID,
      name: parsed.name,
      resumeSessionId: snapshot?.sessionId,
    };
    const invocation = agent === "codex"
      ? planCodex(request)
      : planClaude(request);
    const startOptionsSpecified = snapshot != null && (
      parsed.permission != null || parsed.model != null ||
      parsed.effort != null || parsed.addDirs.length > 0
    );
    if (transport === "direct") {
      return await executeDirect(
        invocation,
        snapshot?.sessionId,
        request.cwd,
        deps,
        parsed.timeoutMs,
      );
    }
    return success(
      await promptHerdr({
        invocation,
        cwd: request.cwd,
        snapshot,
        callerId: request.callerId,
        name: parsed.name,
        timeoutMs: parsed.timeoutMs,
        startOptionsSpecified,
      }, herdrDeps),
    );
  } catch (error) {
    const sessionId = parsed.target;
    const normalized = normalizeError(error);
    if (
      normalized.code === "agent_blocked" && normalized.pane == null &&
      sessionId != null && parsed.kind !== "prompt" &&
      deps.env.HERDR_ENV === "1"
    ) {
      const diagnosed = await diagnoseSessionPane(
        sessionId,
        deps.cwd,
        herdrDeps,
        normalized,
      );
      if (diagnosed != null) {
        return failure(diagnosed, sessionId, undefined, "", {
          activity: "blocked",
        });
      }
    }
    if (
      normalized.code === "session_not_found" && sessionId != null &&
      deps.env.HERDR_ENV === "1" &&
      (parsed.kind !== "prompt" ||
        selectTransport(parsed.transport, deps.env).transport === "herdr")
    ) {
      const diagnosed = await diagnoseSessionPane(
        sessionId,
        deps.cwd,
        herdrDeps,
      );
      if (diagnosed != null) {
        return failure(diagnosed, sessionId, undefined, "", {
          ...(diagnosed.code === "agent_blocked"
            ? { activity: "blocked" as const }
            : {}),
        });
      }
    }
    const knownSessionId = normalized.sessionId ?? sessionId;
    if (
      normalized.code === "agent_blocked" && knownSessionId != null &&
      sessionIdPattern.test(knownSessionId)
    ) {
      try {
        const snapshot = await findNativeSession(knownSessionId, deps.env);
        return failure(normalized, knownSessionId, snapshot.agent, "", {
          activity: "blocked",
        });
      } catch {
        // 원래 blocked 진단을 native 재조회 실패로 덮지 않는다.
      }
    }
    return failure(normalized, knownSessionId);
  }
}

async function executeDirect(
  invocation: NativeInvocation,
  expectedSessionId: string | undefined,
  cwd: string,
  deps: Deps,
  timeoutMs: number,
) {
  let handle;
  let output;
  let sessionId = expectedSessionId;
  let pending = "";
  const tools = new Map<string, string>();
  const onStdout = async (chunk: string) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop()!;
    for (const line of lines) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      for (const event of publicEvents(invocation.agent, value, tools)) {
        if (event.session_id != null) {
          if (!sessionIdPattern.test(event.session_id)) continue;
          sessionId = event.session_id;
        }
        await deps.progress?.(`${
          JSON.stringify({
            transport: "direct",
            agent: invocation.agent,
            session_id: sessionId,
            ...event,
          })
        }\n`);
      }
    }
  };
  try {
    handle = startDirect(invocation, { ...deps, cwd, onStdout }, timeoutMs);
    output = await handle.output;
    if (pending.trim() !== "") await onStdout("\n");
  } catch (error) {
    const aborted = handle == null ? undefined : directAbortStatus(handle);
    return failure(
      new DelegateError(
        aborted === "cancelled"
          ? "cancelled"
          : aborted === "timed_out"
          ? "timeout"
          : "agent_failed",
        error instanceof Error ? error.message : String(error),
      ),
      sessionId,
      invocation.agent,
    );
  }
  const parsed = invocation.agent === "codex"
    ? parseCodexEvents(output.stdout)
    : parseClaudeEvents(output.stdout);
  const aborted = directAbortStatus(handle);
  if (aborted != null) {
    return failure(
      new DelegateError(
        aborted === "cancelled" ? "cancelled" : "timeout",
        aborted === "cancelled" ? "호출자 중단" : "실행 제한 시간 초과",
        undefined,
        parsed.sessionId ?? sessionId,
      ),
      parsed.sessionId ?? sessionId,
      invocation.agent,
    );
  }
  if (
    expectedSessionId != null && parsed.sessionId != null &&
    parsed.sessionId.toLowerCase() !== expectedSessionId.toLowerCase()
  ) {
    return failure(
      new DelegateError(
        "session_id_changed",
        `resume session ID 변경: ${expectedSessionId} -> ${parsed.sessionId}`,
      ),
      expectedSessionId,
      invocation.agent,
    );
  }
  if (output.code !== 0 || parsed.sessionId == null || parsed.result == null) {
    return failure(
      new DelegateError(
        "agent_failed",
        parsed.error ??
          (output.stderr.trim() || "에이전트 결과를 해석할 수 없습니다"),
      ),
      parsed.sessionId ?? sessionId,
      invocation.agent,
    );
  }
  try {
    assertSessionId(parsed.sessionId);
  } catch {
    return failure(
      new DelegateError(
        "session_id_unavailable",
        "native agent가 유효한 session ID를 보고하지 않았습니다",
      ),
      expectedSessionId,
      invocation.agent,
    );
  }
  return success({
    session_id: parsed.sessionId,
    agent: invocation.agent,
    activity: "quiescent",
    result: parsed.result,
  });
}

async function readPrompt(promptFile: string | undefined, deps: Deps) {
  let prompt: string;
  if (promptFile != null) {
    prompt = await Deno.readTextFile(resolve(deps.cwd, promptFile));
  } else {
    if (deps.stdin.isTerminal()) {
      throw new DelegateError("usage", "stdin 프롬프트가 필요합니다");
    }
    prompt = await deps.stdin.text();
  }
  return prompt.replace(/^\uFEFF/, "").replace(/\r?\n$/, "");
}

function selectPromptAgent(
  requested: "auto" | Agent,
  prompt: string,
  detected?: Agent,
): Agent {
  if (detected != null) {
    if (requested !== "auto" && requested !== detected) {
      throw new DelegateError(
        "usage",
        `감지된 agent=${detected}와 --agent=${requested}가 다릅니다`,
      );
    }
    return detected;
  }
  return requested === "auto" ? selectAgent(prompt).agent : requested;
}

function runtimeDeps(deps: Deps): HerdrDeps {
  return {
    exec: deps.exec,
    env: deps.env,
    signal: deps.signal,
    now: deps.now ?? (() => performance.now()),
    sleep: deps.sleep ?? abortableSleep,
  };
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveSleep, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveSleep();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function success(document: DelegateDocument) {
  return { stdout: renderDocument(document), stderr: "", code: 0 };
}

function failure(
  error: DelegateError,
  sessionId?: string,
  agent?: Agent,
  stderr = "",
  context: Pick<DelegateDocument, "activity"> = {},
) {
  const publicSessionId = sessionId != null && sessionIdPattern.test(sessionId)
    ? sessionId as NativeSessionId
    : undefined;
  return {
    stdout: renderDocument({
      ...(publicSessionId == null ? {} : { session_id: publicSessionId }),
      ...(agent == null ? {} : { agent }),
      ...context,
      error: {
        code: error.code,
        message: error.message,
        ...(error.pane == null ? {} : { pane: error.pane }),
      },
      ...(error.screen == null ? {} : { screen: error.screen }),
      ...(error.retry == null ? {} : { retry: error.retry }),
    }),
    stderr,
    code: exitCode(error.code),
  };
}

function tail(text: string, lines: number): string {
  return text.replace(/\n$/, "").split("\n").slice(-lines).join("\n");
}

async function writeText(
  stream: { write(data: Uint8Array): Promise<number> },
  text: string,
): Promise<void> {
  const data = new TextEncoder().encode(text);
  let offset = 0;
  while (offset < data.length) {
    offset += await stream.write(data.subarray(offset));
  }
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  Deno.addSignalListener("SIGINT", interrupt);
  try {
    const result = await runDelegate(Deno.args, {
      exec: denoExec,
      env: Deno.env.toObject(),
      stdin: {
        isTerminal: () => Deno.stdin.isTerminal(),
        text: () => new Response(Deno.stdin.readable).text(),
      },
      cwd: Deno.cwd(),
      signal: controller.signal,
      progress: (text) => writeText(Deno.stderr, text),
    });
    await writeText(Deno.stdout, result.stdout);
    await writeText(Deno.stderr, result.stderr);
    Deno.exit(result.code);
  } finally {
    Deno.removeSignalListener("SIGINT", interrupt);
  }
}

if (import.meta.main) await main();
