import { assertEquals } from "jsr:@std/assert@1.0.19";
import { parseClaudeSession, planClaude } from "./claude.ts";

Deno.test("읽기 전용 Claude는 auto 모드로 판단하고 남은 권한 요청은 유저에게 묻는다", () => {
  const plan = planClaude({
    cwd: "/workspace",
    addDirs: [],
    prompt: "조사",
    budget: 1,
    permission: "read-only",
  });

  for (const args of [plan.directArgs, plan.herdrArgs]) {
    assertEquals(args.includes("--permission-mode=auto"), true);
    assertEquals(args.includes("--permission-mode=dontAsk"), false);
    assertEquals(args.includes("--permission-prompts=none"), false);
    assertEquals(
      args.includes("--tools=Bash,Read,Glob,Grep,WebSearch,WebFetch"),
      true,
    );
  }
});

Deno.test("클로드 작업을 기다리는 중 받은 후속 요청은 작업을 멈추거나 재개 때 정리해야 완료된다", () => {
  const records = (values: unknown[]) =>
    values.map((value, index) => ({ value, start: index, end: index + 1 }));
  const prompt = (content: string) => ({
    type: "user",
    origin: { kind: "human" },
    promptSource: "typed",
    message: { content },
  });
  const started = (id: string) => ({
    type: "user",
    toolUseResult: { backgroundTaskId: id },
  });
  const answer = [
    { type: "assistant", message: { content: [{ type: "text", text: "끝" }] } },
    { type: "system", subtype: "turn_duration" },
  ];
  const waiting = [
    prompt("측정 요청"),
    started("bstop"),
    started("bold"),
    ...answer,
    prompt("진행 상황 요청"),
    ...answer,
  ];
  assertEquals(
    parseClaudeSession(records(waiting)).turns.map((turn) => turn.background),
    [undefined, true],
  );

  const { turns } = parseClaudeSession(records([
    ...waiting,
    {
      type: "user",
      toolUseResult: { task_id: "bstop", task_type: "local_bash" },
    },
    {
      type: "user",
      origin: { kind: "task-notification" },
      promptSource: "system",
      message: {
        content: [
          "<task-notification>",
          "<task-id>bgone</task-id>",
          "<task-id>bold</task-id>",
          "<task-id>__orphan_summary__:shell</task-id>",
          "<status>stopped</status>",
          "</task-notification>",
        ].join("\n"),
      },
    },
    ...answer,
  ]));
  assertEquals(turns.map((turn) => turn.completed), [false, true]);
});
