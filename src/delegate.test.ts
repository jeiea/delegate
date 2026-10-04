import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import { join } from "jsr:@std/path@1.1.6";
import { createTempDir } from "jsr:@jeiea/snippets@0.2.0";
import { runDelegate } from "./delegate.ts";
import { exitCode } from "./document.ts";
import { fakeExec, type FakeResponse } from "./fakes.ts";
import { claudeTrustKeys } from "./herdr.ts";
import { denoExec } from "./process.ts";

const codexId = "019efcf8-381f-74a2-a141-f105f1e00e81";
const claudeId = "c627ecae-f35d-40b1-b5fb-b2b109a52e89";
const cwd = "/workspace";
const prefix = "delegate 스킬 등 다른 에이전트 재위임 금지.\n\n";

// Herdr codex prompt

Deno.test("코덱스 연결이 늦어져도 파일 요청을 지정한 추론 강도로 마치고 대화 기록을 남긴 뒤 패널을 닫는다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  const promptPath = join(dir.path, "prompt.md");
  const nativePath = codexPath(dir.path);
  const filePrompt = "첫 문단입니다.\n\n둘째 문단입니다.\n";
  const sentPrompt = `${prefix}첫 문단입니다.\n\n둘째 문단입니다.`;
  Deno.writeTextFileSync(promptPath, `\uFEFF${filePrompt}`);
  let now = 0;
  const test = setup(dir.path, "stdin은 사용하지 않습니다", [
    herdr({ pane: { workspace_id: "ws-1", tab_id: "tab-current" } }),
    herdr({ tabs: [] }),
    herdr({
      tab: { tab_id: "tab-delegate" },
      root_pane: { pane_id: "pane-delegate" },
    }),
    herdr({ agent: unidentifiedAgent("working", 1) }),
    herdr({ agent: unidentifiedAgent("working", 1) }, {
      onStart: () =>
        writeJsonl(nativePath, [
          codexMeta(),
          ...codexTurn(
            "file",
            "다른 문자열이어도 공식 ID를 따릅니다",
            "완료",
            "complete",
            {
              before: ["AGENTS 지침"],
              after: ["스킬 지침"],
              metadataPrompt: true,
            },
          ),
        ]),
    }),
    herdr({ agent: unidentifiedAgent("working", 1) }),
    herdr({ agent: currentAgent("working", 1) }),
    herdr({}),
    herdr({ agent: liveAgent("done", 2) }),
    herdr({ agent: liveAgent("done", 2) }),
    herdr({}),
  ], {
    env: { HERDR_ENV: "1" },
    now: () => now,
    sleep: (ms) => {
      now += now === 0 ? 6_000 : ms;
      return Promise.resolve();
    },
  });

  const result = await runDelegate([
    "prompt",
    "--agent",
    "codex",
    "--caller-id",
    "caller-file",
    "--prompt-file",
    promptPath,
    "--effort",
    "high",
    "--timeout",
    "1m",
  ], test.deps);

  assertEquals(result.code, 0);
  assertEquals(now >= 6_000, true);
  assertStringIncludes(result.stdout, `session_id: ${codexId}`);
  assertEquals(result.stdout.includes("intervening_prompts:"), false);
  assertStringIncludes(result.stdout, "\n\n완료\n");
  assertEquals(
    test.fake.calls.find((call) => call.args[1] === "prompt")?.args[3],
    sentPrompt,
  );
  const prompt = test.fake.calls.find((call) => call.args[1] === "prompt");
  assertEquals(prompt?.args.includes("--wait"), true);
  assertEquals(prompt?.args.includes("--until"), true);
  assertEquals(prompt?.args.includes("working"), true);
  assertEquals(prompt?.args.includes("blocked"), true);
  assertEquals(prompt?.args.includes("--timeout"), true);
  assertEquals(
    test.fake.calls.some((call) => call.args[1] === "get"),
    true,
  );
  const start = test.fake.calls.find((call) => call.args[1] === "start");
  assertEquals(start?.args.includes("-c"), true);
  assertEquals(start?.args.includes("model_reasoning_effort=high"), true);

  assertEquals(result.stdout.includes("warnings:"), false);
  assertEquals(
    test.fake.calls.filter((call) => call.args[1] === "close").map((call) =>
      call.args
    ),
    [["pane", "close", "pane-delegate"]],
  );

  const logs = await runDelegate(["logs", codexId], test.deps);
  assertEquals(logs.code, 0);
  assertStringIncludes(logs.stdout, "다른 문자열이어도 공식 ID를 따릅니다");
  assertEquals(logs.stdout.includes("AGENTS 지침"), false);
  assertEquals(logs.stdout.includes("스킬 지침"), false);
});

Deno.test("연결 실패 진단에서 확인된 코덱스 세션으로 요청을 다시 보내지 않고 결과 회수를 마친다", async () => {
  for (const paneLookup of ["complete", "failed"] as const) {
    await using dir = await createTempDir({ prefix: "delegate-test-" });
    let now = 0;
    const diagnostic = herdr({ agent: {} });
    const test = setup(dir.path, "작업", [
      ...newTabAllocation(),
      herdr({ agent: unidentifiedAgent("working", 1) }),
      herdr({ agent: unidentifiedAgent("working", 1) }),
      herdr({ agent: unidentifiedAgent("working", 1) }),
      diagnostic,
      ...(paneLookup === "failed"
        ? [herdrFailure("pane unavailable")]
        : [{ cmd: "herdr", stdout: "작업 실행 중\n" }]),
    ], {
      env: { HERDR_ENV: "1" },
      now: () => now,
      sleep: () => {
        now += 10_000;
        return Promise.resolve();
      },
    });
    diagnostic.onStart = () => {
      const name = test.fake.calls.find((call) => call.args[1] === "start")
        ?.args[2];
      diagnostic.stdout = JSON.stringify({
        result: {
          agent: {
            ...currentAgent("working", 1),
            name,
            ...(paneLookup === "complete" ? { pane_id: "pane-delegate" } : {}),
          },
        },
      });
      writeJsonl(codexPath(dir.path), [
        codexMeta(),
        ...codexTurn("late", `${prefix}작업`, "늦게 연결된 작업 완료"),
      ]);
    };
    const first = await runDelegate([
      "prompt",
      "--agent",
      "codex",
      "--caller-id",
      "caller",
      "--timeout",
      "1m",
    ], test.deps);
    assertEquals(now, 10_000);
    assertEquals(first.code, 5);
    assertStringIncludes(first.stdout, `session_id: ${codexId}`);
    if (paneLookup === "complete") {
      assertStringIncludes(first.stdout, "pane_id: pane-delegate");
      assertStringIncludes(first.stdout, "작업 실행 중");
    }
    assertEquals(
      test.fake.calls.some((call) => call.args[1] === "close"),
      false,
    );

    const name = test.fake.calls.find((call) =>
      call.args[1] === "start"
    )!.args[2];
    const live = { ...liveAgent("done", 2), name };
    const recovered = setup(dir.path, "", [
      herdr({ agents: [live] }),
      herdr({ agent: live }),
      herdr({ agent: live }),
      herdr({}),
    ]);
    const waited = await runDelegate(["wait", codexId], {
      ...recovered.deps,
      env: test.deps.env,
    });
    assertEquals(waited.code, 0);
    assertStringIncludes(waited.stdout, "늦게 연결된 작업 완료");
    assertEquals(
      recovered.fake.calls.some((call) => call.args[1] === "prompt"),
      false,
    );
    assertEquals(
      recovered.fake.calls.filter((call) => call.args[1] === "close").map((
        call,
      ) => call.args),
      [["pane", "close", "pane-delegate"]],
    );
  }
});

Deno.test("코덱스 연결 대기 중 시간이 만료되거나 취소되면 전달한 작업의 패널을 보존한다", async () => {
  for (const interruption of ["timeout", "cancelled"] as const) {
    await using dir = await createTempDir({ prefix: "delegate-test-" });
    let now = 0;
    const controller = new AbortController();
    const test = setup(dir.path, "작업", [
      ...newTabAllocation(),
      herdr({ agent: unidentifiedAgent("working", 1) }),
      herdr({ agent: unidentifiedAgent("working", 1) }),
      herdr({ agent: unidentifiedAgent("working", 1) }),
      herdr({}),
    ], {
      env: { HERDR_ENV: "1" },
      signal: controller.signal,
      now: () => now,
      sleep: () => {
        now += 5_000;
        if (interruption === "cancelled") controller.abort();
        return Promise.resolve();
      },
    });
    const result = await runDelegate([
      "prompt",
      "--agent",
      "codex",
      "--caller-id",
      "caller",
      "--timeout",
      "5s",
    ], test.deps);
    assertEquals(result.code, interruption === "timeout" ? 6 : 130);
    assertStringIncludes(result.stdout, `code: ${interruption}`);
    assertEquals(
      test.fake.calls.filter((call) => call.args[1] === "prompt").length,
      1,
    );
    assertEquals(
      test.fake.calls.some((call) => call.args[1] === "close"),
      false,
    );
  }
});

Deno.test("잘못된 코덱스 시작 정보를 진단해도 검증되지 않은 세션 ID를 공개하지 않는다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  const invalid = {
    ...currentAgent("working", 1),
    agent_session: { kind: "id", value: "invalid-id" },
  };
  const diagnostic = herdr({ agent: {} });
  const pane = herdr({ pane: {} });
  const test = setup(dir.path, "작업", [
    ...newTabAllocation(),
    herdr({ agent: invalid }),
    herdrFailure("close refused"),
    diagnostic,
    pane,
    { cmd: "herdr", stdout: "현재 코덱스 화면\n" },
  ], { env: { HERDR_ENV: "1" } });
  diagnostic.onStart = () => {
    const name = test.fake.calls.find((call) => call.args[1] === "start")
      ?.args[2];
    diagnostic.stdout = JSON.stringify({
      result: { agent: { ...invalid, name, pane_id: "pane-delegate" } },
    });
    pane.stdout = JSON.stringify({
      result: { pane: { pane_id: "pane-delegate", agent: name } },
    });
  };
  const result = await runDelegate([
    "prompt",
    "--agent",
    "codex",
    "--caller-id",
    "caller",
  ], test.deps);
  assertEquals(result.code, 5);
  assertStringIncludes(result.stdout, "code: invalid_native_session");
  assertStringIncludes(result.stdout, "pane_id: pane-delegate");
  assertEquals(result.stdout.includes("session_id:"), false);
  assertEquals(
    test.fake.calls.some((call) => call.args[1] === "prompt"),
    false,
  );
});

Deno.test("현재 코덱스 작업 공간을 찾지 못하면 위임을 거부하고 위치가 확인되면 그곳에서 검토를 마친다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  const callerId = "11111111-2222-4333-8444-555555555555";
  const missing = setup(dir.path, "검토 요청", [
    herdr({
      pane: {
        workspace_id: "ws-1",
        tab_id: "tab-stale",
        agent_session: { kind: "id", value: codexId },
      },
    }),
    herdr({ agents: [] }),
  ], { env: { HERDR_ENV: "1", CODEX_THREAD_ID: callerId } });

  const rejected = await runDelegate([
    "prompt",
    "--agent",
    "codex",
    "--timeout",
    "60s",
  ], missing.deps);

  assertEquals(rejected.code, 3);
  assertStringIncludes(rejected.stdout, "caller_session_unavailable");
  assertEquals(missing.fake.calls.map(({ args }) => args), [
    ["pane", "current", "--current"],
    ["agent", "list"],
  ]);

  const path = codexPath(dir.path);
  const responses = completedHerdrResponses(path, `${prefix}검토 요청`);
  responses[0] = herdr({
    pane: {
      workspace_id: "ws-1",
      tab_id: "tab-stale",
      pane_id: "pane-stale",
      cwd: "/other-workspace",
      agent_session: { kind: "id", value: codexId },
    },
  });
  responses.splice(
    1,
    0,
    herdr({
      agents: [{
        agent: "codex",
        agent_session: { kind: "id", value: callerId },
        pane: {
          pane_id: "pane-caller",
          tab_id: "tab-caller",
          workspace_id: "ws-2",
        },
        cwd,
      }],
    }),
  );
  const test = setup(dir.path, "검토 요청", responses, {
    env: { HERDR_ENV: "1", CODEX_THREAD_ID: callerId },
  });

  const result = await runDelegate([
    "prompt",
    "--agent",
    "codex",
    "--timeout",
    "60s",
  ], test.deps);

  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, "완료");
  assertEquals(test.fake.calls.slice(0, 4).map(({ args }) => args), [
    ["pane", "current", "--current"],
    ["agent", "list"],
    ["tab", "list", "--workspace", "ws-2"],
    [
      "tab",
      "create",
      "--workspace",
      "ws-2",
      "--cwd",
      cwd,
      "--label",
      callerId,
      "--no-focus",
    ],
  ]);
});

Deno.test("진행 중인 코덱스 작업에 후속 요청을 보내면 같은 세션의 최신 결과와 로그를 확인하고 정리를 마친다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  const path = codexPath(dir.path);
  const firstPrompt = `${prefix}첫 요청`;
  writeJsonl(path, [codexMeta(), ...codexTurn("turn-1", firstPrompt)]);
  let now = 0;
  let followUpWritten = false;
  const responses: FakeResponse[] = [
    herdr({ agents: [liveAgent("working", 1)] }),
    herdr({ agents: [liveAgent("working", 1)] }),
    herdr({ agent: currentAgent("working", 2) }),
    herdr({ agent: liveAgent("done", 2) }),
    herdr({ agent: liveAgent("done", 2) }),
    herdr({}),
    herdr({ agents: [liveAgent("done", 2)] }),
    herdr({ agent: liveAgent("done", 3) }, {
      onStart: () => {
        const replacement = `${path}.replacement`;
        writeJsonl(replacement, [
          codexMeta(),
          ...codexTurn(
            "turn-2",
            `${prefix}수동 후속 요청`,
            "최신 완료 결과",
          ),
        ]);
        Deno.renameSync(replacement, path);
      },
    }),
    herdr({
      agent: {
        ...liveAgent("done", 3),
        workspace_id: "ws-2",
        tab_id: "tab-moved",
        pane_id: "pane-moved",
      },
    }),
    herdr({}),
    herdr({}),
    herdr({ agents: [] }),
  ];
  const start = setup(dir.path, "후속 요청", responses, {
    env: { HERDR_ENV: "1" },
    now: () => now,
    sleep: (ms) => {
      now += ms;
      if (!followUpWritten && now > 5_000) {
        appendJsonl(path, [
          {
            type: "event_msg",
            payload: { type: "turn_aborted", turn_id: "turn-1" },
          },
          ...codexTurn(
            "turn-follow-up",
            `${prefix}후속 요청`,
            "후속 결과",
          ),
        ]);
        followUpWritten = true;
      }
      return Promise.resolve();
    },
  });

  const status = await runDelegate(["status", codexId], start.deps);
  assertEquals(status.code, 0);
  assertEquals(
    status.stdout,
    `---\nsession_id: ${codexId}\nagent: codex\nactivity: working\n---\n`,
  );

  const prompted = await runDelegate([
    "prompt",
    codexId,
    "--caller-id",
    "caller-1",
  ], start.deps);
  assertEquals(prompted.code, 0);
  assertStringIncludes(prompted.stdout, "후속 결과");
  assertEquals(prompted.stdout.includes("intervening_prompts:"), false);
  assertEquals(now > 5_000, true);
  const followUp = start.fake.calls.find((call) =>
    call.args[1] === "prompt" && call.args[3] === `${prefix}후속 요청`
  );
  assertEquals(followUp?.args.includes("--wait"), false);

  const waited = await runDelegate([
    "wait",
    codexId,
    "--caller-id",
    "caller-1",
    "--name",
    "검토",
  ], start.deps);
  assertEquals(waited.code, 0);
  assertStringIncludes(waited.stdout, "activity: quiescent");
  assertStringIncludes(
    waited.stdout,
    "intervening_prompts:\n  - 수동 후속 요청",
  );
  assertStringIncludes(waited.stdout, "\n\n최신 완료 결과\n");
  assertEquals(
    start.fake.calls.some((call) =>
      call.args.includes("/rename caller-1 검토")
    ),
    true,
  );
  assertEquals(
    start.fake.calls.filter((call) => call.args[1] === "close").map((call) =>
      call.args
    ),
    [
      ["pane", "close", "pane-delegate"],
      ["pane", "close", "pane-moved"],
    ],
  );

  const logs = await runDelegate(
    ["logs", codexId, "--lines", "20"],
    start.deps,
  );
  assertEquals(logs.code, 0);
  assertStringIncludes(logs.stdout, "수동 후속 요청");
  assertStringIncludes(logs.stdout, "최신 완료 결과");
  assertEquals(logs.stdout.includes("secret"), false);

  const closed = await runDelegate([
    "close",
    codexId,
  ], start.deps);
  assertEquals(closed.code, 3);
  assertStringIncludes(closed.stdout, "code: transport_unavailable");

  await using deadlineDir = await createTempDir({ prefix: "delegate-test-" });
  const deadlinePath = codexPath(deadlineDir.path);
  writeJsonl(deadlinePath, [
    codexMeta(),
    ...codexTurn("deadline-old", "기존 요청"),
  ]);
  let deadlineNow = 0;
  const deadline = setup(deadlineDir.path, "나타나지 않는 후속 요청", [
    herdr({ agents: [liveAgent("unknown", 1)] }),
    herdr({}),
  ], {
    env: { HERDR_ENV: "1" },
    now: () => deadlineNow,
    sleep: (ms) => {
      deadlineNow += ms;
      return Promise.resolve();
    },
  });
  const expired = await runDelegate([
    "prompt",
    codexId,
    "--caller-id",
    "caller-1",
    "--timeout",
    "1s",
  ], deadline.deps);
  assertEquals(expired.code, 6);
  assertStringIncludes(expired.stdout, "code: timeout");
  assertStringIncludes(expired.stdout, `session_id: ${codexId}`);
  assertEquals(deadlineNow, 1_000);
});

Deno.test("종료된 코덱스 작업을 재개하면 같은 세션에서 결과를 받고 지정한 이름으로 정리한다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  const sessionCwd = join(dir.path, "stopped-session-workspace");
  Deno.mkdirSync(sessionCwd);
  const path = codexPath(dir.path);
  writeJsonl(path, [
    codexMeta(codexId, sessionCwd),
    ...codexTurn("old", "이전 요청", "이전 결과"),
  ]);
  const deterministic = `dlg-${codexId.replaceAll("-", "").slice(0, 28)}`;
  let now = 0;
  const sleeps: number[] = [];
  const test = setup(dir.path, "수정 요청", [
    herdr({ agents: [] }),
    herdr({ agents: [] }, {
      onStart: () =>
        appendJsonl(
          path,
          codexTurn("pre-submit", "전송 직전 외부 요청", "외부 결과"),
        ),
    }),
    herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
    herdr({ tabs: [] }),
    herdr({
      tab: { tab_id: "tab-delegate" },
      root_pane: { pane_id: "pane-delegate" },
    }),
    herdr({ agent: unidentifiedAgent("working", 1) }),
    herdr({ agent: unidentifiedAgent("working", 1) }, {
      onStart: () =>
        appendJsonl(
          path,
          codexTurn("resumed", `${prefix}수정 요청`, "재개 결과"),
        ),
    }),
    herdr({ agent: unidentifiedAgent("working", 1) }),
    herdrError(
      "agent_not_running",
      "agent is no longer running in the target pane",
    ),
    herdr({
      agents: [liveAgent("working", 2, codexId, sessionCwd)],
    }),
    herdr({ agent_status: "working", state_change_seq: 2 }),
    herdr({ agent: { agent_status: "done", state_change_seq: 3 } }),
    herdr({ agent_status: "done", state_change_seq: 3 }),
    herdr({}),
    herdr({}),
  ], {
    env: { HERDR_ENV: "1" },
    now: () => now,
    sleep: (ms) => {
      now += ms;
      sleeps.push(ms);
      return Promise.resolve();
    },
  });

  const resumed = await runDelegate([
    "prompt",
    codexId,
    "--caller-id",
    "caller",
    "--name",
    "재개 작업",
    "--timeout",
    "2s",
  ], test.deps);
  assertEquals(resumed.code, 0);
  assertStringIncludes(resumed.stdout, "\n\n재개 결과\n");
  assertEquals(resumed.stdout.includes("intervening_prompts:"), false);
  assertEquals(sleeps, [50, 500, 500]);
  assertEquals(
    test.fake.calls.filter((call) => call.args[1] === "wait").length,
    3,
  );
  const start = test.fake.calls.find((call) => call.args[1] === "start");
  assertEquals(start?.cwd, sessionCwd);
  assertEquals(start?.args[2], deterministic);
  assertEquals(start?.args.includes(codexId), true);
  assertEquals(start?.args.includes("--approve-for-me"), true);
  assertEquals(
    test.fake.calls.some((call) =>
      call.args.includes("/rename caller 재개 작업")
    ),
    true,
  );
  assertStringIncludes(Deno.readTextFileSync(path), "재개 결과");

  const changedId = "11111111-2222-3333-4444-555555555555";
  const changedPath = codexPath(dir.path, changedId);
  let changedNow = 0;
  const changed = setup(dir.path, "다른 ID로 바뀌면 안 됩니다", [
    herdr({ agents: [] }),
    herdr({ agents: [] }),
    herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
    herdr({ tabs: [] }),
    herdr({
      tab: { tab_id: "tab-delegate" },
      root_pane: { pane_id: "pane-delegate" },
    }),
    herdr({}),
    herdr({
      agent: currentAgent("working", 1, changedId, sessionCwd),
    }, {
      onStart: () =>
        writeJsonl(changedPath, [
          codexMeta(changedId, sessionCwd),
          ...codexTurn(
            "changed",
            `${prefix}다른 ID로 바뀌면 안 됩니다`,
          ),
        ]),
    }),
  ], {
    env: { HERDR_ENV: "1" },
    now: () => changedNow,
    sleep: (ms) => {
      changedNow += ms;
      return Promise.resolve();
    },
  });
  const rejected = await runDelegate([
    "prompt",
    codexId,
    "--caller-id",
    "caller",
    "--timeout",
    "1s",
  ], changed.deps);
  assertEquals(rejected.code, 5);
  assertStringIncludes(rejected.stdout, "code: session_id_changed");
  assertStringIncludes(rejected.stdout, codexId);
  assertStringIncludes(rejected.stdout, changedId);

  const replacementId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const replacementPath = codexPath(dir.path, replacementId);
  writeJsonl(replacementPath, [
    codexMeta(replacementId),
    ...codexTurn("before-replace", "교체 전 요청", "교체 전 결과"),
  ]);
  let replacementNow = 0;
  const replacement = setup(dir.path, "교체 후 요청", [
    herdr({ agents: [] }),
    herdr({ agents: [] }),
    ...newTabAllocation(),
    herdr({ agent: currentAgent("working", 1, replacementId) }),
    herdr({ agent: currentAgent("working", 1, replacementId) }, {
      onStart: () =>
        appendJsonl(
          replacementPath,
          codexTurn("after-replace", `${prefix}교체 후 요청`),
        ),
    }),
    herdr({ agent: liveAgent("done", 2, replacementId) }, {
      onStart: () => {
        Deno.renameSync(replacementPath, `${replacementPath}.old`);
        writeJsonl(replacementPath, [
          codexMeta(replacementId),
          ...codexTurn(
            "after-replace",
            `${prefix}교체 후 요청`,
            "교체 후 결과",
          ),
        ]);
      },
    }),
    herdr({ agent: liveAgent("done", 2, replacementId) }),
    ...successfulCleanup(),
  ], {
    env: { HERDR_ENV: "1" },
    now: () => replacementNow,
    sleep: (ms) => {
      replacementNow += ms;
      return Promise.resolve();
    },
  });
  const replaced = await runDelegate([
    "prompt",
    replacementId,
    "--caller-id",
    "caller",
  ], replacement.deps);
  assertEquals(replaced.code, 0);
  assertStringIncludes(replaced.stdout, "교체 후 결과");
  assertEquals(replaced.stdout.includes("intervening_prompts:"), false);
});

Deno.test("실행 중인 작업의 권한·추론 강도를 바꾸면 거부하고 모델만 바꾸면 경고와 함께 기존 모델로 작업을 마친다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  writeJsonl(codexPath(dir.path), [codexMeta(), ...codexTurn("old", "old")]);
  for (const option of [["--effort", "medium"], ["--permission", "write"]]) {
    const live = setup(dir.path, "후속", [
      herdr({ agents: [liveAgent("idle", 1)] }),
    ], {
      env: { HERDR_ENV: "1" },
    });
    const conflict = await runDelegate([
      "prompt",
      codexId,
      ...option,
      "--caller-id",
      "caller",
    ], live.deps);
    assertEquals(conflict.code, 2, option[0]);
    assertStringIncludes(conflict.stdout, "code: live_option_conflict");
    assertEquals(live.fake.calls.length, 1);
  }

  let now = 0;
  const idle = setup(dir.path, "후속", [
    herdr({ agents: [liveAgent("idle", 1)] }),
    herdr({ agent: currentAgent("working", 2) }, {
      onStart: () =>
        appendJsonl(codexPath(dir.path), [{
          type: "event_msg",
          payload: { type: "turn_aborted", turn_id: "old" },
        }, ...codexTurn("next", `${prefix}후속`, "후속 완료")]),
    }),
    herdr({ agent: liveAgent("done", 2) }),
    herdr({ agent: liveAgent("done", 2) }),
    ...successfulCleanup(),
  ], {
    env: { HERDR_ENV: "1" },
    now: () => now,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
  });
  const resumed = await runDelegate([
    "prompt",
    codexId,
    "--caller-id",
    "caller",
    "--model",
    "gpt-6-astra",
    "--timeout",
    "1s",
  ], idle.deps);
  assertEquals(resumed.code, 0);
  assertStringIncludes(resumed.stdout, "후속 완료");
  assertStringIncludes(
    resumed.stdout,
    "warnings:\n  - code: resume_option_ignored\n",
  );
  assertStringIncludes(resumed.stdout, "    model: gpt-6-astra\n");
  assertEquals(resumed.stdout.includes("\nmodel:"), false);
  const idlePrompt = idle.fake.calls.find((call) => call.args[1] === "prompt");
  assertEquals(idlePrompt?.args.includes("--wait"), true);
  assertEquals(idlePrompt?.args.includes("working"), true);
  assertEquals(idlePrompt?.args.includes("blocked"), true);
  const timeoutIndex = idlePrompt?.args.indexOf("--timeout") ?? -1;
  assertEquals(
    timeoutIndex >= 0 && Number(idlePrompt?.args[timeoutIndex + 1]) <= 1_000,
    true,
  );
});

Deno.test("작업 중 사람이 요청을 추가하고 패널을 옮기면 최신 결과와 추가 요청을 반환하고 옮긴 패널을 닫는다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  const path = codexPath(dir.path);
  const sent = `${prefix}첫 요청`;
  let now = 0;
  let sleeps = 0;
  const test = setup(dir.path, "첫 요청", [
    herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
    herdr({ tabs: [] }),
    herdr({
      tab: { tab_id: "tab-delegate" },
      root_pane: { pane_id: "pane-delegate" },
    }),
    herdr({ agent: currentAgent("working", 1) }),
    herdr({ agent: currentAgent("working", 1) }, {
      onStart: () =>
        writeJsonl(path, [
          codexMeta(),
          ...codexTurn("turn-1", sent, "첫 결과"),
        ]),
    }),
    herdr({}),
    herdr({ agent: liveAgent("done", 1) }),
    herdr({ agent: liveAgent("done", 2) }),
    herdr({ agent: liveAgent("done", 2) }),
    herdr({
      agent: {
        ...liveAgent("done", 2),
        workspace_id: "ws-2",
        tab_id: "tab-moved",
        pane_id: "pane-moved",
      },
    }),
    herdr({}),
  ], {
    env: { HERDR_ENV: "1" },
    now: () => now,
    sleep: (ms) => {
      now += ms;
      sleeps++;
      if (sleeps === 1) {
        appendJsonl(
          path,
          codexTurn("turn-2", `${prefix}수동 요청`, "최신 결과"),
        );
      }
      return Promise.resolve();
    },
  });
  const result = await runDelegate([
    "prompt",
    "--agent",
    "codex",
    "--caller-id",
    "caller",
  ], test.deps);
  assertEquals(result.code, 0);
  assertStringIncludes(
    result.stdout,
    "intervening_prompts:\n  - 수동 요청",
  );
  assertEquals(result.stdout.includes(prefix), false);
  assertStringIncludes(result.stdout, "\n\n최신 결과\n");
  assertEquals(
    test.fake.calls.filter((call) => call.args[1] === "wait").length,
    2,
  );
  assertEquals(sleeps, 2);
  assertEquals(result.stdout.includes("warnings:"), false);
  assertEquals(
    test.fake.calls.filter((call) => call.args[1] === "close").map((call) =>
      call.args
    ),
    [["pane", "close", "pane-moved"]],
  );
});

Deno.test("사용자 응답을 기다리는 작업은 즉시 차단을 알리고 응답 뒤에는 호출자 ID 없이 대기·정리를 마친다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  const path = codexPath(dir.path);
  const sent = `${prefix}승인 필요`;
  let sleeps = 0;
  const test = setup(dir.path, "승인 필요", [
    herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
    herdr({ tabs: [] }),
    herdr({
      tab: { tab_id: "tab-delegate" },
      root_pane: { pane_id: "pane-delegate" },
    }),
    herdr({ agent: currentAgent("working", 1) }),
    herdr({ agent: currentAgent("blocked", 2) }, {
      onStart: () => writeJsonl(path, [codexMeta(), ...codexTurn("t", sent)]),
    }),
    herdr({
      agent: { ...currentAgent("blocked", 2), pane_id: "pane-delegate" },
    }),
    { cmd: "herdr", stdout: "Approve action?\n" },
    herdr({ agents: [liveAgent("done", 3)] }),
    herdr({ agent: liveAgent("done", 3) }),
    herdr({ agent: liveAgent("done", 3) }),
    ...successfulCleanup(),
  ], {
    env: { HERDR_ENV: "1" },
    now: () => 0,
    sleep: () => {
      sleeps++;
      return Promise.resolve();
    },
  });
  const result = await runDelegate([
    "prompt",
    "--agent",
    "codex",
    "--caller-id",
    "caller",
  ], test.deps);
  assertEquals(result.code, 4);
  assertStringIncludes(result.stdout, "code: agent_blocked");
  assertStringIncludes(result.stdout, "activity: blocked");
  assertStringIncludes(result.stdout, `session_id: ${codexId}`);
  assertStringIncludes(result.stdout, "pane_id: pane-delegate");
  assertStringIncludes(result.stdout, "Approve action?");
  assertEquals(result.stdout.includes("코덱스 샌드박스 권한 허용"), false);
  assertEquals(result.stdout.includes("메인 세션"), false);
  assertEquals(result.stdout.includes("herdr pane read"), false);
  assertStringIncludes(
    result.stdout,
    "herdr pane send-keys pane-delegate <KEY>...",
  );
  assertEquals(sleeps, 0);
  assertEquals(
    test.fake.calls.some((call) => call.args[1] === "close"),
    false,
  );

  appendJsonl(path, [{
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "응답 후 완료" }],
    },
  }, {
    type: "event_msg",
    payload: { type: "task_complete", turn_id: "t" },
  }]);
  const waitStart = test.fake.calls.length;
  const waited = await runDelegate(["wait", codexId], test.deps);
  assertEquals(waited.code, 0);
  assertStringIncludes(waited.stdout, "intervening_prompts:\n  - 승인 필요");
  assertStringIncludes(waited.stdout, "응답 후 완료");
  assertEquals(
    test.fake.calls.slice(waitStart).map((call) => call.args.slice(0, 2)),
    [["agent", "list"], ["agent", "wait"], ["agent", "get"], ["pane", "close"]],
  );
  assertEquals(test.fake.calls.at(-1)?.args, [
    "pane",
    "close",
    "pane-delegate",
  ]);
  assertEquals(waited.stdout.includes("warnings:"), false);
});

Deno.test("두 위임을 동시에 요청해도 각자 작업을 마치고 결과를 받는다", async () => {
  await using firstDir = await createTempDir({ prefix: "delegate-test-" });
  await using secondDir = await createTempDir({ prefix: "delegate-test-" });
  const socketPath = join(firstDir.path, "shared-herdr.sock");
  const firstPrompt = `${prefix}첫 작업`;
  const secondPrompt = `${prefix}둘째 작업`;
  const firstStart = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const secondWaiting = Promise.withResolvers<void>();

  const first = setup(
    firstDir.path,
    "첫 작업",
    completedHerdrResponses(codexPath(firstDir.path), firstPrompt, {
      onAgentStart: async () => {
        firstStart.resolve();
        await releaseFirst.promise;
      },
    }),
    { env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath } },
  );
  const second = setup(
    secondDir.path,
    "둘째 작업",
    completedHerdrResponses(codexPath(secondDir.path), secondPrompt),
    {
      env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath },
      sleep: async () => {
        secondWaiting.resolve();
        await releaseFirst.promise;
      },
    },
  );

  const firstResult = runDelegate([
    "prompt",
    "--agent",
    "codex",
    "--caller-id",
    "caller",
  ], first.deps);
  await firstStart.promise;
  const secondResult = runDelegate([
    "prompt",
    "--agent",
    "codex",
    "--caller-id",
    "caller",
  ], second.deps);
  await secondWaiting.promise;

  const secondCallsBeforeRelease = second.fake.calls.length;
  releaseFirst.resolve();
  const results = await Promise.all([firstResult, secondResult]);
  assertEquals(secondCallsBeforeRelease, 0);
  assertEquals(results.map((result) => result.code), [0, 0]);
  assertEquals(
    results.every((result) => result.stdout.includes("\n\n완료\n")),
    true,
  );
});

Deno.test("같은 중단 세션을 동시에 재개하면 먼저 시작한 요청만 진행한다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  const path = codexPath(dir.path);
  writeJsonl(path, [codexMeta(), ...codexTurn("old", "이전", "완료")]);
  const firstStart = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const secondWaiting = Promise.withResolvers<void>();
  const secondChecked = Promise.withResolvers<void>();
  const socketPath = join(dir.path, "shared-herdr.sock");
  const first = setup(dir.path, "첫 재개", [
    herdr({ agents: [] }),
    herdr({ agents: [] }),
    herdr({ pane: { workspace_id: "ws-1", tab_id: "tab-current" } }),
    herdr({ tabs: [] }),
    herdr({
      tab: { tab_id: "tab-delegate" },
      root_pane: { pane_id: "pane-delegate" },
    }),
    herdr({ agent: currentAgent("working", 1) }, {
      onStart: async () => {
        firstStart.resolve();
        await releaseFirst.promise;
      },
    }),
    herdr({ agent: currentAgent("working", 1) }, {
      onStart: () =>
        appendJsonl(
          path,
          codexTurn("resumed", `${prefix}첫 재개`, "첫 결과"),
        ),
    }),
    herdr({ agent: liveAgent("done", 2) }, {
      onStart: () => secondChecked.promise,
    }),
    herdr({ agent: liveAgent("done", 2) }),
    herdr({}),
  ], {
    env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath },
  });
  const second = setup(dir.path, "둘째 재개", [
    herdr({ agents: [] }),
    herdr({ agents: [liveAgent("working", 1)] }, {
      onStart: () => secondChecked.resolve(),
    }),
  ], {
    env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath },
    sleep: async () => {
      secondWaiting.resolve();
      await releaseFirst.promise;
    },
  });

  const firstResult = runDelegate([
    "prompt",
    codexId,
    "--caller-id",
    "caller",
  ], first.deps);
  await firstStart.promise;
  const secondResult = runDelegate([
    "prompt",
    codexId,
    "--caller-id",
    "caller",
  ], second.deps);
  await secondWaiting.promise;
  releaseFirst.resolve();

  const [firstOutput, secondOutput] = await Promise.all([
    firstResult,
    secondResult,
  ]);
  assertEquals(firstOutput.code, 0);
  assertStringIncludes(firstOutput.stdout, "\n\n첫 결과\n");
  assertEquals(secondOutput.code, 5);
  assertStringIncludes(secondOutput.stdout, "code: live_session_ambiguous");
  assertStringIncludes(
    secondOutput.stdout,
    "session이 다른 호출에서 재개되었습니다",
  );
  assertEquals(
    second.fake.calls.some((call) => call.args[1] === "start"),
    false,
  );
});

Deno.test("먼저 끝난 위임을 정리하는 동안 새 위임을 요청해도 둘 다 완료한다", async () => {
  await using firstDir = await createTempDir({ prefix: "delegate-test-" });
  await using secondDir = await createTempDir({ prefix: "delegate-test-" });
  const socketPath = join(firstDir.path, "shared-herdr.sock");
  const cleanupStarted = Promise.withResolvers<void>();
  const releaseCleanup = Promise.withResolvers<void>();
  const secondWaiting = Promise.withResolvers<void>();

  const first = setup(
    firstDir.path,
    "첫 작업",
    completedHerdrResponses(
      codexPath(firstDir.path),
      `${prefix}첫 작업`,
      {
        onCleanupStart: async () => {
          cleanupStarted.resolve();
          await releaseCleanup.promise;
        },
      },
    ),
    { env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath } },
  );
  const second = setup(
    secondDir.path,
    "둘째 작업",
    completedHerdrResponses(codexPath(secondDir.path), `${prefix}둘째 작업`),
    {
      env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath },
      sleep: async () => {
        secondWaiting.resolve();
        await releaseCleanup.promise;
      },
    },
  );

  const firstResult = runDelegate([
    "prompt",
    "--agent",
    "codex",
    "--caller-id",
    "caller",
  ], first.deps);
  await cleanupStarted.promise;
  const secondResult = runDelegate([
    "prompt",
    "--agent",
    "codex",
    "--caller-id",
    "caller",
  ], second.deps);
  await secondWaiting.promise;
  const secondCallsBeforeRelease = second.fake.calls.length;
  releaseCleanup.resolve();
  const results = await Promise.all([firstResult, secondResult]);

  assertEquals(secondCallsBeforeRelease, 0);
  assertEquals(results.map((result) => result.code), [0, 0]);
});

Deno.test("새 코덱스 작업의 셸 준비가 늦어도 다시 시작해 결과를 받고 함께 실행 중인 작업의 패널은 보존한다", async () => {
  for (
    const allocationKind of ["root", "split"] as const
  ) {
    await using dir = await createTempDir({ prefix: "delegate-test-" });
    const path = codexPath(dir.path);
    const shellError =
      `agent target pane pane-delegate is not an available shell`;
    const sleeps: number[] = [];
    let now = 0;
    const allocation = allocationKind === "root"
      ? [
        herdr({ tabs: [] }),
        herdr({
          tab: { tab_id: "tab-delegate" },
          root_pane: { pane_id: "pane-delegate" },
        }),
      ]
      : [
        herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller" }] }),
        herdr({
          panes: [{
            pane_id: "pane-anchor",
            tab_id: "tab-delegate",
            agent: "busy",
            agent_status: "working",
          }, {
            pane_id: "pane-unknown",
            tab_id: "tab-delegate",
            agent: "unknown-agent",
            agent_status: "unknown",
          }],
        }),
        herdr({ pane: { pane_id: "pane-delegate" } }),
      ];
    const afterPrompt = [
      herdr({ agent: liveAgent("done", 2) }),
      herdr({ agent: liveAgent("done", 2) }),
      herdr({}),
    ];
    const test = setup(dir.path, "작업", [
      herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
      ...allocation,
      herdrFailure(shellError),
      herdr({ agent: currentAgent("working", 1) }),
      herdr({ agent: currentAgent("working", 1) }, {
        onStart: () =>
          writeJsonl(path, [
            codexMeta(),
            ...codexTurn("retry", `${prefix}작업`, "회복 결과"),
          ]),
      }),
      herdr({}),
      ...afterPrompt,
    ], {
      env: { HERDR_ENV: "1" },
      now: () => now,
      sleep: (ms) => {
        now += ms;
        sleeps.push(ms);
        return Promise.resolve();
      },
    });

    const result = await runDelegate([
      "prompt",
      "--agent",
      "codex",
      "--caller-id",
      "caller",
    ], test.deps);

    assertEquals(result.code, 0, allocationKind);
    assertEquals(result.stdout.includes("warnings:"), false);
    assertEquals(
      test.fake.calls.filter((call) => call.args[1] === "close").map((call) =>
        call.args
      ),
      [["pane", "close", "pane-delegate"]],
    );
    assertStringIncludes(
      result.stdout,
      `retry:\n  reason:\n    code: herdr_failed\n    message: ${shellError}\n  result: success`,
    );
    assertStringIncludes(result.stdout, "회복 결과");
    const starts = test.fake.calls.filter((call) => call.args[1] === "start");
    assertEquals(starts.length, 2);
    assertEquals(starts[0]?.args, starts[1]?.args);
    assertEquals(sleeps[0], 100);
    assertEquals(
      test.fake.calls.findIndex((call) => call.args[1] === "prompt") >
        test.fake.calls.findLastIndex((call) => call.args[1] === "start"),
      true,
    );
  }
});

Deno.test("중단된 작업의 셸 준비가 늦으면 다시 시작하고 재개 결과나 재시도 실패 원인을 알린다", async () => {
  for (const retrySucceeds of [true, false]) {
    await using dir = await createTempDir({ prefix: "delegate-test-" });
    const path = codexPath(dir.path);
    writeJsonl(path, [codexMeta(), ...codexTurn("old", "이전", "완료")]);
    const shellError =
      `agent target pane pane-delegate is not an available shell`;
    const responses: FakeResponse[] = [
      herdr({ agents: [] }),
      herdr({ agents: [] }),
      herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
      herdr({ tabs: [] }),
      herdr({
        tab: { tab_id: "tab-delegate" },
        root_pane: { pane_id: "pane-delegate" },
      }),
      herdrFailure(shellError),
      retrySucceeds
        ? herdr({ agent: currentAgent("working", 1) })
        : herdrFailure("retry refused"),
    ];
    if (retrySucceeds) {
      responses.push(
        herdr({ agent: currentAgent("working", 1) }, {
          onStart: () =>
            appendJsonl(
              path,
              codexTurn("resumed", `${prefix}수정`, "재개 결과"),
            ),
        }),
        herdr({ agent_status: "done", state_change_seq: 2 }),
        herdr({ agent: { agent_status: "done", state_change_seq: 2 } }),
        herdr({ agent_status: "done", state_change_seq: 2 }),
        herdr({}),
      );
    }
    const test = setup(dir.path, "수정", responses, {
      env: { HERDR_ENV: "1" },
      now: () => 0,
      sleep: () => Promise.resolve(),
    });

    const result = await runDelegate([
      "prompt",
      codexId,
      "--caller-id",
      "caller",
    ], test.deps);

    assertStringIncludes(result.stdout, `session_id: ${codexId}`);
    assertStringIncludes(result.stdout, `message: ${shellError}`);
    assertStringIncludes(
      result.stdout,
      `result: ${retrySucceeds ? "success" : "failed"}`,
    );
    if (retrySucceeds) {
      assertEquals(result.code, 0);
      assertStringIncludes(result.stdout, "재개 결과");
    } else {
      assertEquals(result.code, 5);
      assertStringIncludes(result.stdout, "message: retry refused");
    }
    const start = test.fake.calls.filter((call) => call.args[1] === "start");
    assertEquals(start.length, 2);
    assertEquals(start[0]?.args[2], liveAgent("done", 2).name);
  }
});

Deno.test("기존 패널에서 작업을 시작할 수 없거나 재시도할 수 없는 오류가 나면 곧바로 원인을 알린다", async () => {
  for (
    const scenario of [
      {
        existing: true,
        message: "agent target pane pane-delegate is not an available shell",
      },
      { existing: false, message: "agent start refused" },
    ]
  ) {
    await using dir = await createTempDir({ prefix: "delegate-test-" });
    const allocation = scenario.existing
      ? [
        herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller" }] }),
        herdr({
          panes: [{
            pane_id: "pane-delegate",
            tab_id: "tab-delegate",
            agent: null,
          }],
        }),
      ]
      : [
        herdr({ tabs: [] }),
        herdr({
          tab: { tab_id: "tab-delegate" },
          root_pane: { pane_id: "pane-delegate" },
        }),
      ];
    let sleeps = 0;
    const test = setup(dir.path, "작업", [
      herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
      ...allocation,
      herdrFailure(scenario.message),
    ], {
      env: { HERDR_ENV: "1" },
      sleep: () => {
        sleeps++;
        return Promise.resolve();
      },
    });

    const result = await runDelegate([
      "prompt",
      "--agent",
      "codex",
      "--caller-id",
      "caller",
    ], test.deps);

    assertEquals(result.code, 5);
    assertStringIncludes(result.stdout, `message: ${scenario.message}`);
    assertEquals(result.stdout.includes("retry:"), false);
    assertEquals(sleeps, 0);
    assertEquals(
      test.fake.calls.filter((call) => call.args[1] === "start").length,
      1,
    );
  }
});

Deno.test("에이전트가 사용자 입력을 기다리거나 시작 직후 종료돼 준비되지 않으면 요청을 보류하고 화면과 대응 위치를 알린다", async () => {
  for (
    const [resume, failure] of [
      [false, "agent_not_ready"],
      [true, "agent_not_ready"],
      // 코덱스가 시작 오류를 출력하고 셸로 돌아가면 Herdr는 감지 시점에 따라 시작 실패나 대기 시간 초과를 알린다.
      [false, "timeout"],
      [true, "timeout"],
      [false, "agent_start_failed"],
    ] as const
  ) {
    await using dir = await createTempDir({ prefix: "delegate-test-" });
    if (resume) {
      writeJsonl(codexPath(dir.path), [
        codexMeta(),
        ...codexTurn("old", "이전", "완료"),
      ]);
    }
    const reason = {
      agent_not_ready: "interactive startup screen requires input",
      agent_start_failed: "agent process exited before becoming interactive",
      timeout: "timed out waiting for agent startup",
    }[failure];
    const test = setup(dir.path, "작업", [
      ...(resume ? [herdr({ agents: [] }), herdr({ agents: [] })] : []),
      ...newTabAllocation(),
      herdrError(failure, reason),
      ...(failure !== "agent_not_ready"
        ? [
          // Herdr는 시작 실패 뒤 에이전트 등록을 해제하고 셸 pane만 남긴다.
          herdrError("agent_not_found", "agent target not found"),
          herdr({ pane: { pane_id: "pane-delegate", cwd } }),
        ]
        : [herdr({
          agent: {
            pane_id: "pane-delegate",
            agent_kind: "codex",
            cwd,
            agent_status: "blocked",
          },
        })]),
      { cmd: "herdr", stdout: "Trust this folder?\n``` suspicious\n" },
    ], { env: { HERDR_ENV: "1" } });

    const result = await runDelegate([
      "prompt",
      ...(resume ? [codexId] : []),
      "--agent",
      "codex",
      "--caller-id",
      "caller",
    ], test.deps);
    const start = test.fake.calls.find((call) => call.args[1] === "start");
    const agentName = start?.args[2];

    assertEquals(result.code, 4, String(resume));
    assertStringIncludes(result.stdout, "code: agent_blocked");
    assertStringIncludes(result.stdout, reason);
    assertStringIncludes(result.stdout, "prompt를 제출하지 않았습니다");
    assertStringIncludes(result.stdout, "pane_id: pane-delegate");
    assertStringIncludes(
      result.stdout,
      "herdr pane send-keys pane-delegate <KEY>...",
    );
    assertEquals(result.stdout.includes("blockers:"), false);
    assertStringIncludes(result.stdout, "Trust this folder?\n``` suspicious\n");
    assertStringIncludes(result.stdout, "````text\nTrust this folder?");
    assertEquals(result.stdout.endsWith("````\n"), true);
    assertEquals(result.stdout.includes(`agent_name: ${agentName}`), false);
    assertEquals(
      result.stdout.includes(`session_id: ${codexId}`),
      resume,
      String(resume),
    );
    assertEquals(
      test.fake.calls.some((call) => call.args[1] === "prompt"),
      false,
    );
    assertEquals(
      test.fake.calls.some((call) =>
        call.args[1] === "close" &&
        (call.args[0] === "pane" || call.args[0] === "tab")
      ),
      false,
    );
  }
});

Deno.test("시작이 차단되면 에이전트 조회가 불완전해도 연결된 패널을 확인해 화면을 보여준다", async () => {
  for (const agentGet of ["failed", "missing-pane"] as const) {
    await using dir = await createTempDir({ prefix: "delegate-test-" });
    const paneResponse = herdr({ pane: {} });
    const test = setup(dir.path, "작업", [
      ...newTabAllocation(),
      herdrError("agent_not_ready", "Trust required"),
      agentGet === "failed" ? herdrFailure("agent get unavailable") : herdr({
        agent: { agent_kind: "codex", cwd, agent_status: "blocked" },
      }),
      paneResponse,
      { cmd: "herdr", stdout: "Trust this folder?\n" },
    ], { env: { HERDR_ENV: "1" } });
    paneResponse.onStart = () => {
      const name = test.fake.calls.find((call) => call.args[1] === "start")
        ?.args[2];
      paneResponse.stdout = JSON.stringify({
        result: {
          pane: {
            pane_id: "pane-delegate",
            agent_name: name,
          },
        },
      });
    };
    const result = await runDelegate([
      "prompt",
      "--agent",
      "codex",
      "--caller-id",
      "caller",
    ], test.deps);
    assertEquals(result.code, 4);
    assertStringIncludes(result.stdout, "pane_id: pane-delegate");
    assertStringIncludes(result.stdout, "Trust this folder?");
    assertEquals(
      test.fake.calls.some((call) =>
        call.args[0] === "pane" && call.args[1] === "get"
      ),
      true,
    );
  }

  await using dir = await createTempDir({ prefix: "delegate-test-" });
  const unverified = setup(dir.path, "작업", [
    ...newTabAllocation(),
    herdrError("agent_not_ready", "Trust required"),
    herdr({ agent: { agent_kind: "codex", cwd, agent_status: "blocked" } }),
    herdr({
      pane: { pane_id: "pane-delegate", agent_name: "unrelated-agent" },
    }),
  ], { env: { HERDR_ENV: "1" } });
  const result = await runDelegate([
    "prompt",
    "--agent",
    "codex",
    "--caller-id",
    "caller",
  ], unverified.deps);
  assertEquals(result.code, 4);
  assertEquals(result.stdout.includes("pane_id:"), false);
  assertEquals(result.stdout.includes("herdr pane send-keys"), false);
  assertEquals(
    unverified.fake.calls.some((call) => call.args[1] === "read"),
    false,
  );
});

Deno.test("차단 화면 조회가 멈춰도 기한 안에 원래 오류와 확인된 패널 위치를 알린다", async () => {
  for (const stalled of ["agent get", "pane get", "pane read"] as const) {
    await using dir = await createTempDir({ prefix: "delegate-test-" });
    const controller = new AbortController();
    let callerAborted = false;
    const watchdog = setTimeout(() => {
      callerAborted = true;
      controller.abort();
    }, 2_500);
    const responses: FakeResponse[] = [
      ...newTabAllocation(),
      herdrError("agent_not_ready", "Trust required"),
      stalled === "agent get"
        ? { cmd: "herdr", waitForAbort: true }
        : stalled === "pane get"
        ? herdrFailure("agent get unavailable")
        : herdr({
          agent: { pane_id: "pane-delegate", agent_kind: "codex", cwd },
        }),
      ...(stalled === "pane get" ? [{ cmd: "herdr", waitForAbort: true }] : []),
      ...(stalled === "pane read"
        ? [{ cmd: "herdr", waitForAbort: true }]
        : []),
    ];
    try {
      const test = setup(dir.path, "작업", responses, {
        env: { HERDR_ENV: "1" },
        signal: controller.signal,
      });
      const result = await runDelegate([
        "prompt",
        "--agent",
        "codex",
        "--caller-id",
        "caller",
        "--timeout",
        "500ms",
      ], test.deps);
      assertEquals(callerAborted, false, stalled);
      assertEquals(result.code, 4, stalled);
      assertStringIncludes(result.stdout, "Trust required");
      assertEquals(
        result.stdout.includes("pane_id: pane-delegate"),
        stalled === "pane read",
        stalled,
      );
      assertEquals(
        test.fake.calls.some((call) => call.args[1] === "close"),
        false,
      );
    } finally {
      clearTimeout(watchdog);
    }
  }

  await using dir = await createTempDir({ prefix: "delegate-test-" });
  const controller = new AbortController();
  let callerAborted = false;
  const watchdog = setTimeout(() => {
    callerAborted = true;
    controller.abort();
  }, 2_500);
  try {
    const test = setup(dir.path, "", [{ cmd: "herdr", waitForAbort: true }], {
      env: { HERDR_ENV: "1" },
      signal: controller.signal,
    });
    const result = await runDelegate(["status", claudeId], test.deps);
    assertEquals(callerAborted, false);
    assertStringIncludes(result.stdout, "code: session_not_found");
  } finally {
    clearTimeout(watchdog);
  }
});

Deno.test("기존 세션에 요청을 보내다 차단되면 해당 패널의 화면을 보여준다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  writeJsonl(codexPath(dir.path), [
    codexMeta(),
    ...codexTurn("old", "이전", "완료"),
  ]);
  const test = setup(dir.path, "새 요청", [
    herdr({ agents: [liveAgent("idle", 1)] }),
    herdrError("agent_blocked", "Approval needed"),
    herdr({ agent: liveAgent("blocked", 2) }),
    { cmd: "herdr", stdout: "Confirm action\n" },
  ], { env: { HERDR_ENV: "1" } });
  const result = await runDelegate(
    ["prompt", codexId, "--caller-id", "caller"],
    test.deps,
  );
  assertEquals(result.code, 4);
  assertStringIncludes(result.stdout, "pane_id: pane-delegate");
  assertStringIncludes(result.stdout, "Confirm action");
  assertEquals(
    test.fake.calls.filter((call) => call.args[1] === "prompt").length,
    1,
  );
});

Deno.test("작업용 셸을 다시 시작하지 못하면 마지막 상태와 재시도 실패 원인을 알린다", async () => {
  for (
    const scenario of [
      { name: "같은 오류", second: "shell", cancel: "none" },
      { name: "다른 오류", second: "other", cancel: "none" },
      { name: "준비 차단", second: "blocked", cancel: "none" },
      { name: "대기 중 취소", second: "none", cancel: "sleep" },
      { name: "두 번째 시작 중 취소", second: "cancel", cancel: "start" },
    ] as const
  ) {
    await using dir = await createTempDir({ prefix: "delegate-test-" });
    const controller = new AbortController();
    const shellError =
      `agent target pane pane-delegate is not an available shell`;
    const responses: FakeResponse[] = [
      herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
      herdr({ tabs: [] }),
      herdr({
        tab: { tab_id: "tab-delegate" },
        root_pane: { pane_id: "pane-delegate" },
      }),
      herdrFailure(shellError),
    ];
    if (scenario.second === "shell") responses.push(herdrFailure(shellError));
    if (scenario.second === "other") {
      responses.push(herdrFailure("retry refused"));
    }
    if (scenario.second === "blocked") {
      responses.push(
        herdrError("agent_not_ready", "interactive startup screen"),
        herdr({
          agent: {
            pane_id: "pane-delegate",
            agent_kind: "codex",
            cwd,
            agent_status: "blocked",
          },
        }),
        { cmd: "herdr", stdout: "Trust this folder?\n" },
      );
    }
    if (scenario.second === "cancel") {
      responses.push({
        cmd: "herdr",
        waitForAbort: true,
        onStart: () => controller.abort(),
      });
    }
    let sleeps = 0;
    const test = setup(dir.path, "작업", responses, {
      env: { HERDR_ENV: "1" },
      signal: controller.signal,
      sleep: () => {
        sleeps++;
        if (scenario.cancel === "sleep") {
          controller.abort();
          return Promise.reject(new DOMException("Aborted", "AbortError"));
        }
        return Promise.resolve();
      },
    });

    const result = await runDelegate([
      "prompt",
      "--agent",
      "codex",
      "--caller-id",
      "caller",
    ], test.deps);

    assertEquals(
      result.code,
      scenario.second === "blocked" ? 4 : scenario.cancel === "none" ? 5 : 130,
      scenario.name,
    );
    assertStringIncludes(result.stdout, "result: failed");
    assertStringIncludes(result.stdout, `message: ${shellError}`);
    if (scenario.second === "other") {
      assertStringIncludes(result.stdout, "message: retry refused");
    }
    if (scenario.second === "blocked") {
      assertStringIncludes(result.stdout, "code: agent_blocked");
      assertStringIncludes(result.stdout, "prompt를 제출하지 않았습니다");
      assertStringIncludes(result.stdout, "pane_id: pane-delegate");
      assertStringIncludes(result.stdout, "Trust this folder?");
      assertEquals(result.stdout.includes("blockers:"), false);
      assertEquals(
        test.fake.calls.some((call) => call.args[1] === "prompt"),
        false,
      );
      assertEquals(
        test.fake.calls.some((call) => call.args[1] === "close"),
        false,
      );
    }
    if (scenario.cancel !== "none") {
      assertStringIncludes(result.stdout, "code: cancelled");
    }
    assertEquals(sleeps, 1);
    assertEquals(
      test.fake.calls.filter((call) => call.args[1] === "start").length,
      scenario.cancel === "sleep" ? 1 : 2,
    );
  }
});

Deno.test("작업용 셸을 다시 시작한 뒤 요청 처리에 실패해도 시작이 회복된 사실과 실패 원인을 알린다", async () => {
  for (
    const failure of [
      "prompt",
      "session",
      "id-unavailable",
      "native-missing",
      "invalid-kind",
      "invalid-id",
      "wait",
      "blocked",
      "raw",
    ] as const
  ) {
    await using dir = await createTempDir({ prefix: "delegate-test-" });
    const path = codexPath(dir.path);
    const shellError =
      `agent target pane pane-delegate is not an available shell`;
    let sleepCalls = 0;
    let now = 0;
    let identityPolling = false;
    const afterRetry: FakeResponse[] = failure === "prompt"
      ? [herdrFailure("prompt refused")]
      : failure === "session"
      ? [
        herdr({
          agent: {
            agent_session: {
              kind: "id",
              value: "11111111-2222-3333-4444-555555555555",
            },
            cwd: "/different-workspace",
          },
        }, {
          onStart: () =>
            writeJsonl(
              codexPath(
                dir.path,
                "11111111-2222-3333-4444-555555555555",
              ),
              [
                codexMeta(
                  "11111111-2222-3333-4444-555555555555",
                  "/different-workspace",
                ),
                ...codexTurn("retry", `${prefix}작업`),
              ],
            ),
        }),
      ]
      : failure === "id-unavailable"
      ? [
        herdr({ agent: unidentifiedAgent("working", 1) }, {
          onStart: () => {
            identityPolling = true;
          },
        }),
        herdr({ agent: unidentifiedAgent("working", 1) }),
        herdr({}),
        herdr({ panes: [] }),
        herdr({}),
      ]
      : failure === "native-missing"
      ? [
        herdr({ agent: currentAgent("working", 1) }, {
          onStart: () => {
            identityPolling = true;
          },
        }),
        herdr({
          agent: { ...currentAgent("working", 1), pane_id: "pane-delegate" },
        }),
        { cmd: "herdr", stdout: "Still starting\n" },
      ]
      : failure === "invalid-kind" || failure === "invalid-id"
      ? [
        herdr({
          agent: {
            ...unidentifiedAgent("working", 1),
            agent_session: failure === "invalid-kind"
              ? { kind: "path", value: codexId }
              : { kind: "id", value: "not-a-session-id" },
          },
        }),
        herdr({}),
        herdr({ panes: [] }),
        herdr({}),
      ]
      : [
        herdr({ agent: currentAgent("working", 1) }, {
          onStart: () => {
            if (failure !== "raw") {
              writeJsonl(path, [
                codexMeta(),
                ...codexTurn("retry", `${prefix}작업`),
              ]);
            }
          },
        }),
        ...(failure === "wait"
          ? [
            herdr({}),
            herdrFailure("wait refused"),
            herdrFailure("list refused"),
          ]
          : failure === "blocked"
          ? [
            herdr({}),
            herdr({ agent: liveAgent("blocked", 2) }),
            herdr({
              agent: {
                ...currentAgent("blocked", 2),
                pane_id: "pane-delegate",
              },
            }),
            { cmd: "herdr", stdout: "Approval needed\n" },
          ]
          : failure === "raw"
          ? []
          : []),
      ];
    const test = setup(dir.path, "작업", [
      herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
      herdr({ tabs: [] }),
      herdr({
        tab: { tab_id: "tab-delegate" },
        root_pane: { pane_id: "pane-delegate" },
      }),
      herdrFailure(shellError),
      herdr({
        agent: failure === "id-unavailable"
          ? unidentifiedAgent("working", 1)
          : currentAgent("working", 1),
      }),
      ...afterRetry,
    ], {
      env: { HERDR_ENV: "1" },
      now: () => now,
      sleep: (_ms) => {
        sleepCalls++;
        if (failure === "raw" && sleepCalls === 2) {
          throw new Error("session lookup exploded");
        }
        if (identityPolling) now += 10_000;
        return Promise.resolve();
      },
    });

    const result = await runDelegate([
      "prompt",
      "--agent",
      "codex",
      "--caller-id",
      "caller",
      "--timeout",
      "1m",
    ], test.deps);

    assertEquals(result.code === 0, false, failure);
    assertStringIncludes(result.stdout, "result: success");
    assertStringIncludes(result.stdout, `message: ${shellError}`);
    if (failure === "blocked") {
      assertStringIncludes(result.stdout, "code: agent_blocked");
      assertStringIncludes(result.stdout, "activity: blocked");
      assertStringIncludes(result.stdout, "pane_id: pane-delegate");
      assertStringIncludes(result.stdout, "Approval needed");
    }
    if (failure === "raw" || failure === "session") {
      assertStringIncludes(
        result.stdout,
        `code: ${
          failure === "raw" ? "agent_failed" : "invalid_native_session"
        }`,
      );
    }
    if (failure === "wait") {
      assertStringIncludes(result.stdout, "code: herdr_failed");
      assertStringIncludes(result.stdout, "message: wait refused");
    }
    if (failure === "prompt") {
      assertStringIncludes(result.stdout, "code: herdr_failed");
      assertStringIncludes(result.stdout, "message: prompt refused");
      assertEquals(
        test.fake.calls.some((call) => call.args[1] === "close"),
        false,
      );
    }
    if (failure === "raw") {
      assertEquals(
        test.fake.calls.filter((call) =>
          call.args[0] === "agent" && call.args[1] === "prompt"
        ).length,
        1,
      );
    }
    if (failure === "id-unavailable") {
      assertStringIncludes(result.stdout, "code: session_id_unavailable");
      assertEquals(now, 10_000);
    }
    if (failure === "native-missing") {
      assertStringIncludes(result.stdout, "code: invalid_native_session");
      assertStringIncludes(result.stdout, `session_id: ${codexId}`);
      assertStringIncludes(result.stdout, "pane_id: pane-delegate");
      assertStringIncludes(result.stdout, "Still starting");
    }
    if (failure === "invalid-kind" || failure === "invalid-id") {
      assertStringIncludes(result.stdout, "code: invalid_native_session");
    }
    if (
      [
        "invalid-kind",
        "invalid-id",
      ].includes(failure)
    ) {
      assertEquals(
        test.fake.calls.some((call) =>
          call.args.join(" ") === "pane close pane-delegate"
        ),
        true,
      );
    }
    if (failure === "native-missing" || failure === "id-unavailable") {
      assertEquals(
        test.fake.calls.some((call) => call.args[1] === "close"),
        false,
      );
    }
  }
});

Deno.test("코덱스 훅 승인 때문에 요청이 진행되지 않으면 패널을 보존하고 승인 화면을 보여준다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  let now = 0;
  const diagnostic = herdr({ agent: {} });
  const test = setup(dir.path, "짧은 요청", [
    ...newTabAllocation(),
    herdr({ agent: unidentifiedAgent("idle", 1) }),
    herdrError(
      "agent_prompt_stalled",
      "agent prompt produced no observed working or blocked state within 5000 ms; current status is idle",
    ),
    herdr({
      agent: unidentifiedAgent("idle", 1),
    }),
    diagnostic,
    { cmd: "herdr", stdout: "Hooks need review\n" },
  ], {
    env: { HERDR_ENV: "1" },
    now: () => now,
    sleep: () => {
      now += 10_000;
      return Promise.resolve();
    },
  });
  diagnostic.onStart = () => {
    const name = test.fake.calls.find((call) => call.args[1] === "start")
      ?.args[2];
    diagnostic.stdout = JSON.stringify({
      result: {
        agent: {
          ...unidentifiedAgent("idle", 1),
          name,
          pane_id: "pane-delegate",
        },
      },
    });
  };

  const result = await runDelegate([
    "prompt",
    "--agent",
    "codex",
    "--caller-id",
    "caller",
    "--timeout",
    "1m",
  ], test.deps);

  assertEquals(result.code, 5);
  assertStringIncludes(result.stdout, "code: session_id_unavailable");
  assertStringIncludes(result.stdout, "pane_id: pane-delegate");
  assertStringIncludes(result.stdout, "Hooks need review");
  assertStringIncludes(result.stdout, "herdr integration install codex");
  assertEquals(
    test.fake.calls.some((call) => call.args[1] === "close"),
    false,
  );
});

Deno.test("허더 작업이 시작되거나 완료되기를 기다리다 제한 시간이 지나거나 취소되면 확인된 세션을 알린다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  const path = codexPath(dir.path);
  writeJsonl(path, [codexMeta(), ...codexTurn("old", "이전", "완료")]);
  let now = 0;
  let delayedPromptWritten = false;
  const sleeps: number[] = [];
  const timed = setup(dir.path, "늦은 prompt", [
    herdr({ agents: [] }),
    herdr({ agents: [] }),
    herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
    herdr({ tabs: [] }),
    herdr({
      tab: { tab_id: "tab-delegate" },
      root_pane: { pane_id: "pane-delegate" },
    }),
    herdr({ agent: currentAgent("working", 1) }),
    herdr({ agent: currentAgent("working", 1) }),
    herdr({ agent_status: "done", state_change_seq: 2 }),
    herdr({ agent_status: "done", state_change_seq: 2 }),
    herdr({ agent_status: "done", state_change_seq: 2 }),
  ], {
    env: { HERDR_ENV: "1" },
    now: () => now,
    sleep: (ms) => {
      now += ms;
      sleeps.push(ms);
      if (!delayedPromptWritten) {
        appendJsonl(
          path,
          codexTurn("late", `${prefix}늦은 prompt`, "늦은 결과"),
        );
        delayedPromptWritten = true;
      }
      return Promise.resolve();
    },
  });
  const timeout = await runDelegate([
    "prompt",
    codexId,
    "--caller-id",
    "caller",
    "--timeout",
    "600ms",
  ], timed.deps);
  assertEquals(timeout.code, 6);
  assertStringIncludes(timeout.stdout, "code: timeout");
  assertStringIncludes(timeout.stdout, `session_id: ${codexId}`);
  assertEquals(now, 600);
  assertEquals(sleeps, [500, 100]);

  const controller = new AbortController();
  const cancelled = setup(dir.path, "", [
    herdr({ agents: [liveAgent("working", 3)] }),
    {
      cmd: "herdr",
      waitForAbort: true,
      onStart: () => controller.abort(),
    },
  ], {
    env: { HERDR_ENV: "1" },
    signal: controller.signal,
  });
  const interrupted = await runDelegate(["wait", codexId], cancelled.deps);
  assertEquals(interrupted.code, 130);
  assertStringIncludes(interrupted.stdout, "code: cancelled");
  assertStringIncludes(interrupted.stdout, `session_id: ${codexId}`);

  const newController = new AbortController();
  const createdId = "55555555-6666-7777-8888-999999999999";
  const createdPath = codexPath(dir.path, createdId);
  const created = setup(dir.path, "신규 중단", [
    herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
    herdr({ tabs: [] }),
    herdr({
      tab: { tab_id: "tab-new" },
      root_pane: { pane_id: "pane-new" },
    }),
    herdr({ agent: currentAgent("working", 1, createdId) }),
    herdr({ agent: currentAgent("working", 1, createdId) }, {
      onStart: () =>
        writeJsonl(
          createdPath,
          [
            codexMeta(createdId),
            ...codexTurn("new", `${prefix}신규 중단`),
          ],
        ),
    }),
    herdr({}),
    {
      cmd: "herdr",
      waitForAbort: true,
      onStart: () => newController.abort(),
    },
  ], {
    env: { HERDR_ENV: "1" },
    signal: newController.signal,
  });
  const createdInterrupted = await runDelegate([
    "prompt",
    "--agent",
    "codex",
    "--caller-id",
    "caller-new",
  ], created.deps);
  assertEquals(createdInterrupted.code, 130);
  assertStringIncludes(createdInterrupted.stdout, "code: cancelled");
  assertStringIncludes(createdInterrupted.stdout, `session_id: ${createdId}`);
});

Deno.test("허더 작업의 제한 시간이 지나면 시작에 실패한 패널을 정리하고 요청이 전달됐을 수 있는 패널은 보존한다", async () => {
  for (const stage of ["start", "prompt"] as const) {
    await using dir = await createTempDir({ prefix: "delegate-test-" });
    const controller = new AbortController();
    const responses: FakeResponse[] = [
      ...newTabAllocation(),
      ...(stage === "prompt" ? [herdr({})] : []),
      { cmd: "herdr", waitForAbort: true },
      herdr({}),
      herdr({ panes: [] }),
      herdr({}),
    ];
    const test = setup(dir.path, "작업", responses, {
      env: { HERDR_ENV: "1" },
      signal: controller.signal,
    });
    const safety = setTimeout(() => controller.abort(), 150);

    const result = await runDelegate([
      "prompt",
      "--agent",
      "codex",
      "--caller-id",
      "caller",
      "--timeout",
      "20ms",
    ], test.deps);
    clearTimeout(safety);

    assertEquals(result.code, 6, stage);
    assertStringIncludes(result.stdout, "code: timeout", stage);
    const gated = test.fake.calls.find((call) => call.args[1] === stage);
    const timeout = Number(gated?.args[gated.args.indexOf("--timeout") + 1]);
    assertEquals(
      Number.isInteger(timeout) && timeout > 0 && timeout <= 20,
      true,
    );
    assertEquals(
      test.fake.calls.some((call) =>
        call.args.join(" ") === "pane close pane-delegate"
      ),
      stage === "start",
      stage,
    );
  }

  await using cancelledDir = await createTempDir({ prefix: "delegate-test-" });
  const cancelledController = new AbortController();
  const cancelled = setup(cancelledDir.path, "작업", [
    ...newTabAllocation(),
    herdr({ agent: unidentifiedAgent("working", 1) }),
    {
      cmd: "herdr",
      waitForAbort: true,
      onStart: () => cancelledController.abort(),
    },
    herdr({}),
    herdr({ panes: [] }),
    herdr({}),
  ], {
    env: { HERDR_ENV: "1" },
    signal: cancelledController.signal,
  });
  const cancelledResult = await runDelegate([
    "prompt",
    "--agent",
    "codex",
    "--caller-id",
    "caller",
  ], cancelled.deps);
  assertEquals(cancelledResult.code, 130);
  assertStringIncludes(cancelledResult.stdout, "code: cancelled");
  assertEquals(
    cancelled.fake.calls.some((call) =>
      call.args.join(" ") === "pane close pane-delegate"
    ),
    false,
  );

  for (
    const scenario of [{ elapsed: 0, expected: 30_000 }, {
      elapsed: 40_000,
      expected: 20_000,
    }]
  ) {
    await using dir = await createTempDir({ prefix: "delegate-test-" });
    let now = 0;
    const allocation = newTabAllocation();
    allocation.at(-1)!.onStart = () => {
      now = scenario.elapsed;
    };
    const test = setup(dir.path, "작업", [
      ...allocation,
      herdrFailure("start refused"),
      herdr({}),
      herdr({ panes: [] }),
      herdr({}),
    ], {
      env: { HERDR_ENV: "1" },
      now: () => now,
    });

    const result = await runDelegate([
      "prompt",
      "--agent",
      "codex",
      "--caller-id",
      "caller",
      "--timeout",
      "1m",
    ], test.deps);

    assertEquals(result.code, 5);
    const start = test.fake.calls.find((call) => call.args[1] === "start");
    assertEquals(
      start?.args[start.args.indexOf("--timeout") + 1],
      String(scenario.expected),
    );
  }

  await using gateDir = await createTempDir({ prefix: "delegate-test-" });
  const gatePath = codexPath(gateDir.path);
  const lockPath = join(gateDir.path, "herdr.sock.delegate-pane.lock");
  let gateNow = 0;
  let lockReleasedBeforeIdentityLookup = false;
  const gate = setup(gateDir.path, "게이트 뒤 작업", [
    ...newTabAllocation(),
    herdr({ agent: unidentifiedAgent("unknown", 1) }),
    {
      cmd: "herdr",
      code: 1,
      stderr: JSON.stringify({
        error: { code: "timeout", message: "activity gate stalled" },
      }),
      onStart: () =>
        writeJsonl(gatePath, [
          codexMeta(),
          ...codexTurn(
            "gate-timeout",
            `${prefix}게이트 뒤 작업`,
            "게이트 뒤 완료",
          ),
        ]),
    },
    herdr({ agent: currentAgent("working", 1) }, {
      onStart: async () => {
        const lock = await Deno.open(lockPath, {
          create: true,
          read: true,
          write: true,
        });
        lockReleasedBeforeIdentityLookup = await lock.tryLock(true);
        if (lockReleasedBeforeIdentityLookup) await lock.unlock();
        lock.close();
      },
    }),
    herdr({}),
    herdr({ agent: liveAgent("done", 2) }),
    herdr({ agent: liveAgent("done", 2) }),
    ...successfulCleanup(),
  ], {
    env: { HERDR_ENV: "1" },
    now: () => gateNow,
    sleep: (ms) => {
      gateNow += ms;
      return Promise.resolve();
    },
  });
  const gated = await runDelegate([
    "prompt",
    "--agent",
    "codex",
    "--caller-id",
    "caller",
    "--timeout",
    "1m",
  ], gate.deps);
  assertEquals(gated.code, 0);
  assertStringIncludes(gated.stdout, "게이트 뒤 완료");
  assertEquals(lockReleasedBeforeIdentityLookup, true);
  const gatePrompt = gate.fake.calls.find((call) => call.args[1] === "prompt");
  assertEquals(
    gatePrompt?.args[gatePrompt.args.indexOf("--timeout") + 1],
    "30000",
  );

  await using unidentifiedDir = await createTempDir({
    prefix: "delegate-test-",
  });
  let unidentifiedNow = 0;
  const unidentified = setup(unidentifiedDir.path, "식별되지 않는 작업", [
    ...newTabAllocation(),
    herdr({ agent: unidentifiedAgent("unknown", 1) }),
    {
      cmd: "herdr",
      code: 1,
      stderr: JSON.stringify({
        error: { code: "timeout", message: "activity gate stalled" },
      }),
    },
    herdr({ agent: unidentifiedAgent("unknown", 1) }),
  ], {
    env: { HERDR_ENV: "1" },
    now: () => unidentifiedNow,
    sleep: () => {
      unidentifiedNow += 10_000;
      return Promise.resolve();
    },
  });
  const unidentifiedResult = await runDelegate([
    "prompt",
    "--agent",
    "codex",
    "--caller-id",
    "caller",
    "--timeout",
    "1m",
  ], unidentified.deps);
  assertEquals(unidentifiedResult.code, 5);
  assertStringIncludes(
    unidentifiedResult.stdout,
    "code: session_id_unavailable",
  );
  assertEquals(unidentifiedNow, 10_000);
  assertEquals(
    unidentified.fake.calls.some((call) =>
      ["pane", "tab"].includes(call.args[0] ?? "") &&
      call.args[1] === "close"
    ),
    false,
  );
});

Deno.test("사용자 취소와 제한 시간 초과가 겹치면 취소 결과와 확인된 세션을 알린다", async () => {
  for (const simultaneous of [false, true]) {
    await using dir = await createTempDir({ prefix: "delegate-test-" });
    const path = codexPath(dir.path);
    const controller = new AbortController();
    const blocking: FakeResponse = simultaneous
      ? {
        cmd: "herdr",
        waitForAbort: true,
        onStart: async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          controller.abort();
        },
      }
      : { cmd: "herdr", waitForAbort: true };
    const test = setup(dir.path, "작업", [
      ...newTabAllocation(),
      herdr({ agent: currentAgent("working", 1) }),
      herdr({ agent: currentAgent("working", 1) }, {
        onStart: () =>
          writeJsonl(path, [
            codexMeta(),
            ...codexTurn("turn", `${prefix}작업`),
          ]),
      }),
      blocking,
    ], {
      env: { HERDR_ENV: "1" },
      signal: controller.signal,
    });
    const safety = simultaneous
      ? undefined
      : setTimeout(() => controller.abort(), 150);

    const result = await runDelegate([
      "prompt",
      "--agent",
      "codex",
      "--caller-id",
      "caller",
      "--timeout",
      "20ms",
    ], test.deps);
    if (safety != null) clearTimeout(safety);

    assertEquals(result.code, simultaneous ? 130 : 6);
    assertStringIncludes(
      result.stdout,
      `code: ${simultaneous ? "cancelled" : "timeout"}`,
    );
    assertStringIncludes(result.stdout, `session_id: ${codexId}`);
    assertEquals(test.fake.calls.length, 6);
  }
});

Deno.test("작업 완료 후 이름 변경이나 정리 중 취소되면 중단 오류를 알린다", async () => {
  for (
    const scenario of [
      { stage: "rename-command", interruption: "cancelled" },
      { stage: "rename-pause", interruption: "timeout" },
      { stage: "cleanup-close", interruption: "cancelled" },
    ] as const
  ) {
    await using dir = await createTempDir({ prefix: "delegate-test-" });
    const path = codexPath(dir.path);
    const controller = new AbortController();
    const responses = completedUntilPostProcessing(path, `${prefix}작업`);
    if (scenario.stage.startsWith("rename")) {
      responses.push(
        scenario.stage === "rename-command"
          ? {
            cmd: "herdr",
            waitForAbort: true,
            onStart: () => controller.abort(),
          }
          : herdr({}),
        ...successfulCleanup(),
      );
    } else {
      responses.push({
        cmd: "herdr",
        waitForAbort: true,
        onStart: () => controller.abort(),
      });
    }
    let sleepCalls = 0;
    const logicalNow = 0;
    const test = setup(dir.path, "작업", responses, {
      env: {
        HERDR_ENV: "1",
        HERDR_SOCKET_PATH: join(dir.path, "herdr.sock"),
      },
      signal: controller.signal,
      now: () => logicalNow,
      sleep: (_ms, signal) => {
        sleepCalls++;
        const shouldBlock = scenario.stage === "rename-pause" && sleepCalls > 1;
        if (!shouldBlock) {
          return Promise.resolve();
        }
        return new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 100);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        });
      },
    });

    const result = await runDelegate([
      "prompt",
      "--agent",
      "codex",
      "--caller-id",
      "caller",
      ...(scenario.stage.startsWith("rename") ? ["--name", "표시"] : []),
      "--timeout",
      scenario.stage === "rename-pause" || scenario.stage === "cleanup-close"
        ? "100ms"
        : "20ms",
    ], test.deps);

    assertEquals(
      result.code,
      scenario.interruption === "cancelled" ? 130 : 6,
      scenario.stage,
    );
    assertStringIncludes(result.stdout, `code: ${scenario.interruption}`);
    assertStringIncludes(result.stdout, `session_id: ${codexId}`);
    assertEquals(result.stdout.includes("warnings:"), false, scenario.stage);
    assertEquals(
      scenario.stage.startsWith("rename")
        ? test.fake.calls.some((call) =>
          call.args.some((arg) => arg.startsWith("/rename "))
        )
        : test.fake.calls.some((call) =>
          call.args.join(" ") === "pane close pane-delegate"
        ),
      true,
      scenario.stage,
    );
    assertEquals(
      test.fake.calls.length,
      {
        "rename-command": 9,
        "rename-pause": 9,
        "cleanup-close": 9,
      }[scenario.stage],
      scenario.stage,
    );
  }
});

Deno.test("에이전트 시작에 실패하면 새 패널을 정리하고 요청 전송에 실패하면 패널을 보존한다", async () => {
  for (const allocation of ["tab", "pane"] as const) {
    for (const stage of ["start", "prompt"] as const) {
      await using dir = await createTempDir({ prefix: "delegate-test-" });
      const shellError =
        "agent target pane pane-delegate is not an available shell";
      const original = stage === "start" ? "retry refused" : "prompt refused";
      const responses: FakeResponse[] = [
        ...(allocation === "tab" ? newTabAllocation() : splitPaneAllocation()),
        ...(stage === "start"
          ? [herdrFailure(shellError), herdrFailure(original)]
          : [herdr({}), herdrFailure(original)]),
        herdr({}),
      ];
      const test = setup(dir.path, "작업", responses, {
        env: { HERDR_ENV: "1" },
        now: () => 0,
        sleep: () => Promise.resolve(),
      });

      const result = await runDelegate([
        "prompt",
        "--agent",
        "codex",
        "--caller-id",
        "caller",
      ], test.deps);

      assertEquals(result.code, 5, `${allocation}-${stage}`);
      assertStringIncludes(result.stdout, `message: ${original}`);
      if (stage === "start") {
        assertStringIncludes(result.stdout, "result: failed");
        assertStringIncludes(result.stdout, `message: ${shellError}`);
      }
      assertEquals(
        test.fake.calls.filter((call) => call.args[1] === "close").map((call) =>
          call.args
        ),
        stage === "start" ? [["pane", "close", "pane-delegate"]] : [],
        `${allocation}-${stage}`,
      );
    }
  }
});

Deno.test("에이전트를 시작하기 전 작업 공간 준비에 실패하면 허더 오류를 알린다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  const reason = "pane lookup agent not ready";
  const test = setup(dir.path, "작업", [
    herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
    herdrError("agent_not_ready", reason),
  ], { env: { HERDR_ENV: "1" } });

  const result = await runDelegate([
    "prompt",
    "--agent",
    "codex",
    "--caller-id",
    "caller",
  ], test.deps);

  assertEquals(result.code, 5);
  assertStringIncludes(result.stdout, "code: herdr_failed");
  assertStringIncludes(result.stdout, reason);
  assertEquals(
    test.fake.calls.some((call) =>
      call.args[0] === "agent" && call.args[1] === "start"
    ),
    false,
  );
});

Deno.test("시작 실패를 정리하다 오류가 나도 원래 실패 원인을 알리고 기존 패널은 보존한다", async () => {
  for (
    const cleanupFailure of [
      "ordinary",
      "missing",
      "cancelled",
      "timeout",
    ] as const
  ) {
    await using dir = await createTempDir({ prefix: "delegate-test-" });
    const controller = new AbortController();
    const cleanupResponse: FakeResponse = cleanupFailure === "ordinary"
      ? herdrFailure("close refused")
      : cleanupFailure === "missing"
      ? herdrError("pane_not_found", "pane pane-delegate not found")
      : {
        cmd: "herdr",
        waitForAbort: true,
        ...(cleanupFailure === "cancelled"
          ? { onStart: () => controller.abort() }
          : {}),
      };
    const test = setup(dir.path, "작업", [
      ...newTabAllocation(),
      herdrFailure("start refused"),
      cleanupResponse,
    ], {
      env: { HERDR_ENV: "1" },
      signal: controller.signal,
    });
    const safety = cleanupFailure === "timeout"
      ? setTimeout(() => controller.abort(), 150)
      : undefined;

    const result = await runDelegate([
      "prompt",
      "--agent",
      "codex",
      "--caller-id",
      "caller",
      "--timeout",
      "20ms",
    ], test.deps);
    if (safety != null) clearTimeout(safety);

    assertEquals(result.code, 5, cleanupFailure);
    assertStringIncludes(result.stdout, "message: start refused");
    assertEquals(
      test.fake.calls.filter((call) => call.args[1] === "close").map((call) =>
        call.args
      ),
      [["pane", "close", "pane-delegate"]],
      cleanupFailure,
    );
  }

  await using sharedDir = await createTempDir({ prefix: "delegate-test-" });
  const shared = setup(sharedDir.path, "작업", [
    ...newTabAllocation(),
    herdrFailure("start refused"),
    herdr({}),
  ], { env: { HERDR_ENV: "1" } });
  const sharedResult = await runDelegate([
    "prompt",
    "--agent",
    "codex",
    "--caller-id",
    "caller",
  ], shared.deps);
  assertEquals(sharedResult.code, 5);
  assertStringIncludes(sharedResult.stdout, "message: start refused");
  assertEquals(
    shared.fake.calls.filter((call) => call.args[1] === "close").map((call) =>
      call.args
    ),
    [["pane", "close", "pane-delegate"]],
  );

  await using dir = await createTempDir({ prefix: "delegate-test-" });
  const reused = setup(dir.path, "작업", [
    herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
    herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller" }] }),
    herdr({
      panes: [{
        pane_id: "pane-delegate",
        tab_id: "tab-delegate",
        agent: null,
      }],
    }),
    herdrFailure("start refused"),
  ], { env: { HERDR_ENV: "1" } });
  const result = await runDelegate([
    "prompt",
    "--agent",
    "codex",
    "--caller-id",
    "caller",
  ], reused.deps);
  assertEquals(result.code, 5);
  assertStringIncludes(result.stdout, "message: start refused");
  assertEquals(
    reused.fake.calls.some((call) => call.args[1] === "close"),
    false,
  );
});

Deno.test("같은 세션을 실행하는 에이전트가 여럿이면 추가 작업을 시작하거나 요청을 보내지 않는다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  writeJsonl(codexPath(dir.path), [
    codexMeta(),
    ...codexTurn("old", "old", "done"),
  ]);
  const first = liveAgent("working", 1);
  const second = {
    ...liveAgent("idle", 2),
    name: "duplicate",
    pane_id: "pane-2",
  };
  const test = setup(dir.path, "후속", [herdr({ agents: [first, second] })], {
    env: { HERDR_ENV: "1" },
  });
  const result = await runDelegate([
    "prompt",
    codexId,
    "--caller-id",
    "caller",
  ], test.deps);
  assertEquals(result.code, 5);
  assertStringIncludes(result.stdout, "code: live_session_ambiguous");
  assertEquals(test.fake.calls.length, 1);
  assertEquals(test.fake.calls[0]?.args, ["agent", "list"]);
});

Deno.test("허더 연결 위치가 없거나 상대 경로이면 위임을 시작하지 않는다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  for (const socketPath of ["", "relative/herdr.sock"]) {
    const test = setup(dir.path, "작업", [], {
      env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath },
    });
    const result = await runDelegate([
      "prompt",
      "--agent",
      "codex",
      "--caller-id",
      "caller",
    ], test.deps);
    assertEquals(result.code, 3);
    assertStringIncludes(result.stdout, "code: transport_unavailable");
    assertEquals(test.fake.calls, []);
  }
});

// Herdr claude prompt

Deno.test("클로드 신뢰 항목은 현재 선택 위치에 맞춰 인접한 항목만 수락한다", () => {
  assertEquals(claudeTrustKeys("❯ No, exit\n  Yes, I trust this folder\n"), [
    "down",
    "enter",
  ]);
  assertEquals(claudeTrustKeys("  Yes, I trust this folder\n❯ No, exit\n"), [
    "up",
    "enter",
  ]);
  assertEquals(claudeTrustKeys("❯ Yes, I trust this folder\n  No, exit\n"), [
    "enter",
  ]);
  for (
    const screen of [
      "Trust this folder?",
      "  No, exit\n  Yes, I trust this folder\n",
      "❯ Other approval\n  Yes, I trust this folder\n",
      "❯ No, exit\n  Other option\n  Yes, I trust this folder\n",
      "  Yes, I trust this folder\n\n❯ No, exit\n",
    ]
  ) {
    assertEquals(claudeTrustKeys(screen), undefined, screen);
  }
});

Deno.test("클로드 신뢰 수락 중 취소되거나 전체 시간이 만료되면 중단 원인을 알리고 패널을 정리한다", async (t) => {
  for (const interruption of ["cancelled", "timeout", "deadline"] as const) {
    await t.step(interruption, async () => {
      await using dir = await createTempDir({ prefix: "delegate-test-" });
      const controller = new AbortController();
      let now = 0;
      const test = setup(dir.path, "작업", [
        ...newTabAllocation(),
        herdrError("agent_not_ready", "Trust required"),
        ...(interruption === "timeout"
          ? [{ cmd: "herdr", waitForAbort: true }]
          : [
            {
              cmd: "herdr",
              stdout: "❯ No, exit\n  Yes, I trust this folder\n",
            },
            herdr({}, {
              onStart: () => {
                if (interruption === "deadline") now = 100;
              },
            }),
            ...(interruption === "deadline" ? [] : [{
              cmd: "herdr",
              waitForAbort: true,
              onStart: () => controller.abort(),
            }]),
          ]),
        herdr({}),
      ], {
        env: { HERDR_ENV: "1" },
        signal: controller.signal,
        now: () => now,
      });
      const result = await runDelegate([
        "prompt",
        "--agent",
        "claude",
        "--caller-id",
        "caller",
        "--timeout",
        "100ms",
      ], test.deps);
      const code = interruption === "cancelled" ? "cancelled" : "timeout";
      assertEquals(result.code, exitCode(code), result.stdout);
      assertStringIncludes(result.stdout, `code: ${code}`);
      const start = test.fake.calls.find((call) => call.args[1] === "start")!;
      const id = start.args.find((arg) => arg.startsWith("--session-id="))!
        .slice(13);
      assertStringIncludes(result.stdout, `session_id: ${id}`);
      assertEquals(test.fake.calls.at(-1)?.args, [
        "pane",
        "close",
        "pane-delegate",
      ]);
      assertEquals(
        test.fake.calls.some((call) => call.args[1] === "prompt"),
        false,
      );
      assertEquals(
        test.fake.calls.some((call) => call.args[1] === "wait"),
        interruption === "cancelled",
      );
    });
  }
});

Deno.test("클로드는 모든 권한 모드에서 폴더 신뢰를 한 번 수락하고 준비된 뒤 요청을 제출한다", async () => {
  for (
    const { permission, timeout, remaining } of [
      {
        permission: "read-only",
        timeout: "2s",
        remaining: "1750",
      },
      {
        permission: "write",
        timeout: "60s",
        remaining: "30000",
      },
    ]
  ) {
    await using dir = await createTempDir({ prefix: "delegate-test-" });
    let now = 0;
    const test = setup(dir.path, "작업", [
      ...newTabAllocation(),
      herdrError("agent_not_ready", "Trust required"),
      { cmd: "herdr", stdout: "❯ No, exit\n  Yes, I trust this folder\n" },
      herdr({}, {
        onStart: () => {
          now = 250;
        },
      }),
      herdr({ agent: unidentifiedClaude("idle", 1) }),
      herdr({ agent: unidentifiedClaude("working", 2) }, {
        onStart: () => {
          const start = test.fake.calls.find((call) =>
            call.args[1] === "start"
          )!;
          const id = start.args.find((arg) => arg.startsWith("--session-id="))!
            .slice(13);
          writeJsonl(claudePath(dir.path, id), [
            ...claudeOpen(`${prefix}작업`, id),
            {
              type: "assistant",
              sessionId: id,
              cwd,
              requestId: "req-final",
              isSidechain: false,
              message: {
                role: "assistant",
                content: [{ type: "text", text: "완료" }],
              },
            },
            { type: "system", subtype: "turn_duration", sessionId: id, cwd },
          ]);
        },
      }),
      herdr({ agent: unidentifiedClaude("working", 2) }),
      herdr({}),
      herdr({ agent: unidentifiedClaude("done", 3) }),
      herdr({ agent: unidentifiedClaude("done", 3) }),
      herdr({}),
    ], { env: { HERDR_ENV: "1" }, now: () => now });
    const result = await runDelegate([
      "prompt",
      "--agent",
      "claude",
      "--caller-id",
      "caller",
      "--permission",
      permission,
      "--timeout",
      timeout,
    ], test.deps);
    assertEquals(result.code, 0, result.stdout);
    assertStringIncludes(result.stdout, "\n\n완료\n");
    const name = test.fake.calls.find((call) =>
      call.args[1] === "start"
    )!.args[2];
    assertEquals(test.fake.calls.slice(4, 7).map((call) => call.args), [
      ["pane", "read", "pane-delegate", "--source", "visible"],
      ["agent", "send-keys", name, "down", "enter"],
      [
        "agent",
        "wait",
        name,
        "--until",
        "idle",
        "--timeout",
        remaining,
      ],
    ]);
    assertEquals(test.fake.calls[7]?.args.slice(0, 4), [
      "agent",
      "prompt",
      name,
      `${prefix}작업`,
    ]);
    assertEquals(
      test.fake.calls.filter((call) => call.args[1] === "send-keys").length,
      1,
    );
  }
});

Deno.test("클로드 폴더 신뢰 수락 후에도 차단되거나 실패하면 요청을 보류하고 현재 화면을 보여준다", async () => {
  for (const outcome of ["blocked", "timeout"] as const) {
    await using dir = await createTempDir({ prefix: "delegate-test-" });
    const test = setup(dir.path, "작업", [
      ...newTabAllocation(),
      herdrError("agent_not_ready", "Trust required"),
      { cmd: "herdr", stdout: "❯ No, exit\n  Yes, I trust this folder\n" },
      herdr({}),
      outcome === "blocked"
        ? herdr({ agent: unidentifiedClaude("blocked", 1) })
        : herdrError("timeout", "wait expired"),
      herdr({
        agent: {
          ...unidentifiedClaude("blocked", 1),
          pane_id: "pane-delegate",
        },
      }),
      { cmd: "herdr", stdout: "Current blocked screen\n" },
    ], { env: { HERDR_ENV: "1" } });
    const result = await runDelegate([
      "prompt",
      "--agent",
      "claude",
      "--caller-id",
      "caller",
    ], test.deps);
    assertEquals(result.code, 4, outcome);
    assertStringIncludes(result.stdout, "code: agent_blocked");
    assertStringIncludes(result.stdout, "prompt를 제출하지 않았습니다");
    assertStringIncludes(result.stdout, "pane_id: pane-delegate");
    assertStringIncludes(result.stdout, "Current blocked screen");
    assertEquals(
      test.fake.calls.filter((call) => call.args[1] === "send-keys").length,
      1,
    );
    assertEquals(
      test.fake.calls.some((call) =>
        ["prompt", "close"].includes(call.args[1])
      ),
      false,
    );
  }
});

Deno.test("허더에서 클로드 작업을 시작하면 지정한 이름과 추론 강도를 적용하고 발급한 세션과 다른 응답은 거부한다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  const test = setup(dir.path, "화면 작업", [
    herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
    herdr({ tabs: [] }),
    herdr({
      tab: { tab_id: "tab-delegate" },
      root_pane: { pane_id: "pane-delegate" },
    }),
    herdr({ agent: unidentifiedClaude("working", 1) }),
    herdr({ agent: unidentifiedClaude("working", 1) }, {
      onStart: () => {
        const start = test.fake.calls.find((call) => call.args[1] === "start");
        const assignedId = start?.args.find((arg) =>
          arg.startsWith("--session-id=")
        )?.slice("--session-id=".length);
        if (assignedId == null) {
          throw new Error("Claude start에 --session-id가 없습니다");
        }
        writeJsonl(claudePath(dir.path, assignedId), [
          ...claudeOpen(`${prefix}화면 작업`, assignedId),
          {
            type: "assistant",
            sessionId: assignedId,
            cwd,
            requestId: "req-final",
            isSidechain: false,
            message: {
              role: "assistant",
              content: [{ type: "text", text: "완료" }],
            },
          },
          {
            type: "system",
            subtype: "turn_duration",
            sessionId: assignedId,
            cwd,
            timestamp: "2026-09-16T00:00:01Z",
          },
        ]);
      },
    }),
    herdr({ agent: unidentifiedClaude("working", 1) }),
    herdr({}),
    herdr({ agent: unidentifiedClaude("done", 2) }),
    herdr({ agent: unidentifiedClaude("done", 2) }),
    herdr({}),
  ], { env: { HERDR_ENV: "1" } });

  const started = await runDelegate([
    "prompt",
    "--agent",
    "claude",
    "--caller-id",
    "caller-claude",
    "--name",
    "화면",
    "--effort",
    "high",
  ], test.deps);
  assertEquals(started.code, 0);
  assertStringIncludes(started.stdout, "\n\n완료\n");
  const start = test.fake.calls.find((call) => call.args[1] === "start");
  assertEquals(start?.args.includes("--name=caller-claude 화면"), true);
  assertEquals(start?.args.includes("--effort=high"), true);
  const assignedId = start?.args.find((arg) => arg.startsWith("--session-id="))
    ?.slice("--session-id=".length);
  assertEquals(assignedId == null, false);
  assertStringIncludes(started.stdout, `session_id: ${assignedId}`);

  const conflictSetup = setup(dir.path, "후속", [
    herdr({ agents: [claudeLive("idle", 3, assignedId!)] }),
  ], { env: { HERDR_ENV: "1" } });
  const conflict = await runDelegate([
    "prompt",
    assignedId!,
    "--caller-id",
    "caller-claude",
    "--name",
    "새 이름",
  ], conflictSetup.deps);
  assertEquals(conflict.code, 2);
  assertStringIncludes(conflict.stdout, "code: live_option_conflict");

  const waitName = await runDelegate([
    "wait",
    assignedId!,
    "--name",
    "새 이름",
  ], conflictSetup.deps);
  assertEquals(waitName.code, 2);
  assertStringIncludes(waitName.stdout, "code: usage");
  assertEquals(conflictSetup.fake.calls.length, 1);

  await using mismatchDir = await createTempDir({ prefix: "delegate-test-" });
  let mismatchNow = 0;
  const mismatch = setup(mismatchDir.path, "불일치", [
    ...newTabAllocation(),
    herdr({ agent: currentClaude("working", 1) }),
    herdr({}),
    herdr({ panes: [] }),
    herdr({}),
  ], {
    env: { HERDR_ENV: "1" },
    now: () => mismatchNow,
    sleep: (ms) => {
      mismatchNow += ms;
      return Promise.resolve();
    },
  });
  const mismatched = await runDelegate([
    "prompt",
    "--agent",
    "claude",
    "--caller-id",
    "caller",
  ], mismatch.deps);
  assertEquals(mismatched.code, 5);
  assertStringIncludes(mismatched.stdout, "code: session_id_changed");
  const mismatchedStart = mismatch.fake.calls.find((call) =>
    call.args[1] === "start"
  );
  const mismatchedAssignedId = mismatchedStart?.args.find((arg) =>
    arg.startsWith("--session-id=")
  )?.slice("--session-id=".length);
  assertEquals(mismatchedAssignedId == null, false);
  assertStringIncludes(mismatched.stdout, mismatchedAssignedId!);
  assertStringIncludes(mismatched.stdout, claudeId);
  assertEquals(
    mismatch.fake.calls.some((call) => call.args[1] === "prompt"),
    false,
  );
  assertEquals(
    mismatch.fake.calls.some((call) =>
      call.args.join(" ") === "pane close pane-delegate"
    ),
    true,
  );
});

Deno.test("클로드 시작에 승인이 필요하면 기록이 생기기 전에도 후속 명령에서 연결된 패널의 현재 화면을 보여준다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  const started = setup(dir.path, "작업", [
    ...newTabAllocation(),
    herdrError("agent_not_ready", "Trust required"),
    { cmd: "herdr", stdout: "Trust this folder?\n" },
    herdr({
      agent: {
        pane_id: "pane-delegate",
        agent_kind: "claude",
        cwd,
        agent_status: "blocked",
      },
    }),
    { cmd: "herdr", stdout: "Trust this folder?\n" },
  ], { env: { HERDR_ENV: "1" } });
  const first = await runDelegate([
    "prompt",
    "--agent",
    "claude",
    "--caller-id",
    "caller",
  ], started.deps);
  const start = started.fake.calls.find((call) => call.args[1] === "start")!;
  const id = start.args.find((arg) => arg.startsWith("--session-id="))!.slice(
    13,
  );
  assertEquals(start.args[2], `dlg-${id.replaceAll("-", "").slice(0, 28)}`);
  assertStringIncludes(first.stdout, `session_id: ${id}`);
  assertStringIncludes(first.stdout, "pane_id: pane-delegate");
  assertStringIncludes(first.stdout, "Trust this folder?");
  assertEquals(first.code, 4);
  assertEquals(
    started.fake.calls.some((call) =>
      ["send-keys", "prompt"].includes(call.args[1])
    ),
    false,
  );

  for (
    const command of ["status", "wait", "logs", "close", "prompt"] as const
  ) {
    for (const status of ["blocked", "idle"] as const) {
      const live = { ...claudeLive(status, 1, id), name: start.args[2] };
      const test = setup(dir.path, "다음 작업", [
        herdr({ agents: [live] }),
        herdr({ agent: live }),
        { cmd: "herdr", stdout: `Current screen: ${status}\n` },
      ], { env: { HERDR_ENV: "1" } });
      const args = command === "prompt"
        ? ["prompt", id, "--transport", "herdr"]
        : [command, id];
      const result = await runDelegate(args, test.deps);
      assertEquals(
        result.code,
        status === "blocked" ? 4 : 5,
        `${command}/${status}`,
      );
      assertStringIncludes(
        result.stdout,
        `code: ${
          status === "blocked" ? "agent_blocked" : "invalid_native_session"
        }`,
      );
      assertStringIncludes(result.stdout, "pane_id: pane-delegate");
      assertStringIncludes(result.stdout, `Current screen: ${status}`);
      assertEquals(result.stdout.includes("blockers:"), false);
      assertEquals(
        test.fake.calls.some((call) =>
          ["prompt", "close"].includes(call.args[1] ?? "")
        ),
        false,
      );
    }
  }
});

Deno.test("클로드에 요청한 뒤 차단되면 기록이 없어도 패널 화면과 차단 상태를 보여준다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  let now = 0;
  const identity = herdr({ agent: {} });
  const diagnostic = herdr({ agent: {} });
  const test = setup(dir.path, "작업", [
    ...newTabAllocation(),
    herdr({ agent: unidentifiedClaude("working", 1) }),
    herdr({ agent: unidentifiedClaude("blocked", 2) }),
    identity,
    diagnostic,
    { cmd: "herdr", stdout: "Workspace trust required\n" },
  ], {
    env: { HERDR_ENV: "1" },
    now: () => now,
    sleep: () => {
      now += 10_000;
      return Promise.resolve();
    },
  });
  for (const response of [identity, diagnostic]) {
    response.onStart = () => {
      const name = test.fake.calls.find((call) => call.args[1] === "start")
        ?.args[2];
      response.stdout = JSON.stringify({
        result: {
          agent: {
            ...unidentifiedClaude("blocked", 2),
            name,
            pane_id: "pane-delegate",
          },
        },
      });
    };
  }
  const result = await runDelegate([
    "prompt",
    "--agent",
    "claude",
    "--caller-id",
    "caller",
  ], test.deps);
  assertEquals(result.code, 4);
  assertStringIncludes(result.stdout, "code: agent_blocked");
  assertStringIncludes(result.stdout, "pane_id: pane-delegate");
  assertStringIncludes(result.stdout, "Workspace trust required");
  assertEquals(
    test.fake.calls.filter((call) => call.args[1] === "prompt").length,
    1,
  );
  assertEquals(test.fake.calls.some((call) => call.args[1] === "close"), false);
});

// Direct claude / codex prompt

Deno.test("클로드와 코덱스에 직접 요청하면 공개 진행 상황과 최종 답변을 받고 같은 작업 공간에서 재개한다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  for (const agent of ["claude", "codex"] as const) {
    const id = agent === "codex" ? codexId : claudeId;
    const sessionCwd = join(dir.path, `${agent}-session-workspace`);
    Deno.mkdirSync(sessionCwd);
    const progress: string[] = [];
    const events = agent === "codex"
      ? [
        { type: "thread.started", thread_id: codexId },
        { type: "turn.started" },
        {
          type: "item.completed",
          item: { type: "reasoning", text: "private-reasoning" },
        },
        {
          type: "item.started",
          item: { type: "command_execution", command: "secret-argument" },
        },
        {
          type: "item.completed",
          item: {
            type: "command_execution",
            aggregated_output: "secret-output",
          },
        },
        {
          type: "item.completed",
          item: { type: "agent_message", text: "# 완료\n\n본문" },
        },
        { type: "turn.completed" },
      ]
      : [
        { type: "system", subtype: "init", session_id: claudeId },
        {
          type: "assistant",
          message: {
            content: [
              { type: "thinking", thinking: "private-reasoning" },
              {
                type: "tool_use",
                id: "call",
                name: "Read",
                input: "secret-argument",
              },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [{
              type: "tool_result",
              tool_use_id: "call",
              content: "secret-output",
            }],
          },
        },
        {
          type: "result",
          session_id: claudeId,
          subtype: "success",
          is_error: false,
          result: "# 완료\n\n본문",
        },
      ];
    const output = events.map(line).join("");
    const test = setup(dir.path, "작업", [{
      cmd: agent,
      stdoutChunks: [output.slice(0, 17), output.slice(17)],
      afterOutput: () => {
        assertStringIncludes(progress.join(""), id);
        assertStringIncludes(progress.join(""), "direct");
        assertStringIncludes(progress.join(""), "tool_started");
        assertStringIncludes(progress.join(""), "tool_completed");
        if (agent === "codex") {
          writeJsonl(codexPath(dir.path), [
            codexMeta(id, sessionCwd),
            ...codexTurn("first", `${prefix}작업`, "# 완료\n\n본문"),
          ]);
        } else {
          writeJsonl(claudePath(dir.path), [
            ...claudeOpen(`${prefix}작업`, id, sessionCwd),
            {
              type: "assistant",
              message: { content: [{ type: "text", text: "# 완료\n\n본문" }] },
            },
            { type: "system", subtype: "turn_duration" },
          ]);
        }
      },
    }], {
      env: {
        HERDR_ENV: "1",
        HERDR_WORKSPACE_ID: "private-workspace",
        KEEP_ME: "yes",
      },
    });
    const result = await runDelegate([
      "prompt",
      "--agent",
      agent,
      "--transport",
      "direct",
    ], {
      ...test.deps,
      cwd: sessionCwd,
      progress: (text) => {
        progress.push(text);
      },
    });
    assertEquals(result.code, 0);
    assertEquals(result.stdout.includes("run_id:"), false);
    assertEquals(test.fake.calls[0]?.env.KEEP_ME, "yes");
    assertEquals(
      Object.keys(test.fake.calls[0]?.env ?? {}).some((key) =>
        key.startsWith("HERDR_")
      ),
      false,
    );
    assertEquals(
      test.fake.calls[0]?.args.includes(
        agent === "codex" ? "--approve-for-me" : "--permission-mode=auto",
      ),
      true,
    );
    assertEquals(
      test.fake.calls[0]?.args.some((arg) =>
        arg.startsWith(
          agent === "codex" ? "model_reasoning_effort=" : "--effort=",
        )
      ),
      false,
    );
    assertEquals(
      result.stdout,
      `---\nsession_id: ${id}\nagent: ${agent}\nactivity: quiescent\n---\n\n# 완료\n\n본문\n`,
    );
    for (
      const secret of [
        "private-reasoning",
        "secret-argument",
        "secret-output",
        "# 완료\n\n본문",
      ]
    ) {
      assertEquals(progress.join("").includes(secret), false);
    }

    const resumed = setup(dir.path, "후속 요청", [{
      cmd: agent,
      stdout: agent === "codex"
        ? line({ type: "thread.started", thread_id: id }) + line({
          type: "item.completed",
          item: { type: "agent_message", text: "재개 결과" },
        })
        : line({
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: id,
          result: "재개 결과",
        }),
    }]);
    const continued = await runDelegate(
      ["prompt", id, "--transport", "direct"],
      resumed.deps,
    );
    assertEquals(continued.code, 0);
    assertStringIncludes(continued.stdout, `session_id: ${id}`);
    assertStringIncludes(continued.stdout, "\n\n재개 결과\n");
    assertEquals(resumed.fake.calls[0]?.cwd, sessionCwd);
    assertEquals(
      resumed.fake.calls[0]?.args.includes(
        agent === "codex" ? "--approve-for-me" : "--permission-mode=auto",
      ),
      true,
    );
    assertEquals(
      resumed.fake.calls[0]?.args.some((arg) =>
        arg.startsWith(
          agent === "codex" ? "model_reasoning_effort=" : "--effort=",
        )
      ),
      false,
    );

    const changedId = "11111111-2222-3333-4444-555555555555";
    const changed = setup(dir.path, "다음 요청", [{
      cmd: agent,
      stdout: agent === "codex"
        ? line({ type: "thread.started", thread_id: changedId }) + line({
          type: "item.completed",
          item: { type: "agent_message", text: "잘못된 재개" },
        })
        : line({
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: changedId,
          result: "잘못된 재개",
        }),
    }]);
    const rejected = await runDelegate(
      ["prompt", id, "--transport", "direct"],
      changed.deps,
    );
    assertEquals(rejected.code, 5);
    assertStringIncludes(rejected.stdout, "code: session_id_changed");
    assertStringIncludes(rejected.stdout, id);
    assertStringIncludes(rejected.stdout, changedId);
    assertEquals(changed.fake.calls[0]?.cwd, sessionCwd);
  }
});

Deno.test("호출자와 같은·다른 에이전트나 모델 소속으로 대상을 고르고 그 에이전트에 맞는 첫 모델만 넘긴다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  const cases = [
    {
      env: { CODEX_THREAD_ID: "thread", CLAUDECODE: "1" },
      args: ["--agent", "same", "--model", "opus", "--model", "gpt-6-astra"],
      agent: "codex",
      model: "gpt-6-astra",
    },
    {
      env: { CLAUDECODE: "1" },
      args: ["--agent", "same", "--model", "gpt-6-astra", "--model", "foo-1"],
      agent: "claude",
      model: "foo-1",
    },
    {
      env: { CLAUDECODE: "1" },
      args: ["--agent", "other", "--model", "sonnet", "--model", "o4-mini"],
      agent: "codex",
      model: "o4-mini",
    },
    {
      env: { CODEX_THREAD_ID: "thread" },
      args: ["--agent", "other", "--model", "codex-mini"],
      agent: "claude",
      model: undefined,
    },
    {
      env: {},
      args: ["--model", "foo-1", "--model", "gpt-6-astra"],
      agent: "codex",
      model: "foo-1",
    },
    { env: {}, args: ["--model", "foo-1"], agent: "claude", model: "foo-1" },
  ] as const;
  for (const { env, args, agent, model } of cases) {
    const test = setup(dir.path, "프론트엔드 구현", [directReply(agent)], {
      env,
    });
    const result = await runDelegate(
      ["prompt", "--transport", "direct", ...args],
      test.deps,
    );
    const label = args.join(" ");
    assertEquals(result.code, 0, label);
    assertEquals(test.fake.calls[0]?.cmd, agent, label);
    assertEquals(passedModel(test.fake.calls[0]?.args ?? []), model, label);
    assertEquals(
      result.stdout.includes(`\nmodel: ${model}\n`),
      model != null,
      label,
    );
    assertEquals(result.stdout.includes("\nmodel:"), model != null, label);
  }

  const unknown = setup(dir.path, "작업", [], {
    env: { CODEX_THREAD_ID: "", CLAUDECODE: "0" },
  });
  const rejected = await runDelegate(
    ["prompt", "--transport", "direct", "--agent", "same"],
    unknown.deps,
  );
  assertEquals(rejected.code, 2);
  assertStringIncludes(rejected.stdout, "code: usage");
  assertEquals(unknown.fake.calls, []);
});

Deno.test("종료된 세션을 다른 에이전트로 재개하도록 요청하면 경고 후 감지된 에이전트와 맞는 모델로 재개한다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  writeJsonl(codexPath(dir.path), [codexMeta(), ...codexTurn("old", "old")]);
  const mismatch = setup(dir.path, "후속", [directReply("codex")]);
  const resumed = await runDelegate([
    "prompt",
    codexId,
    "--transport",
    "direct",
    "--agent",
    "claude",
    "--model",
    "opus",
    "--model",
    "gpt-6-astra",
  ], mismatch.deps);
  assertEquals(resumed.code, 0);
  assertEquals(mismatch.fake.calls[0]?.cmd, "codex");
  assertEquals(passedModel(mismatch.fake.calls[0]?.args ?? []), "gpt-6-astra");
  assertStringIncludes(resumed.stdout, "\nmodel: gpt-6-astra\n");
  assertStringIncludes(
    resumed.stdout,
    "warnings:\n  - code: resume_option_ignored\n",
  );
  assertStringIncludes(resumed.stdout, "    agent: claude\n");

  const guessed = setup(dir.path, "프론트엔드 구현", [directReply("codex")]);
  const auto = await runDelegate(
    ["prompt", codexId, "--transport", "direct"],
    guessed.deps,
  );
  assertEquals(auto.code, 0);
  assertEquals(auto.stdout.includes("warnings:"), false);
});

Deno.test("선택한 CLI가 없으면 설치된 에이전트로 요청을 마치고 대체 사유와 실제 모델을 알린다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  for (const agent of ["codex", "claude"] as const) {
    const preferred = agent === "codex" ? "claude" : "codex";
    const model = agent === "codex" ? "gpt-6-astra" : "opus";
    for (const option of [preferred, "same", "other", "auto"]) {
      const test = setup(dir.path, "작업", [directReply(agent)], {
        installed: [agent],
        env: option === "other"
          ? agent === "codex"
            ? { CODEX_THREAD_ID: "caller" }
            : { CLAUDECODE: "1" }
          : preferred === "codex"
          ? { CODEX_THREAD_ID: "caller" }
          : { CLAUDECODE: "1" },
      });
      const result = await runDelegate([
        "prompt",
        "--agent",
        option,
        "--model",
        preferred === "codex" ? "gpt-6-astra" : "opus",
        "--model",
        model,
      ], test.deps);
      assertEquals(result.code, 0, result.stdout);
      assertEquals(test.fake.calls.length, 1);
      assertEquals(test.fake.calls[0].cmd, agent);
      assertEquals(passedModel(test.fake.calls[0].args), model);
      assertStringIncludes(result.stdout, `\nagent: ${agent}\n`);
      assertStringIncludes(result.stdout, "code: agent_fallback");
      assertStringIncludes(result.stdout, `agent: ${preferred}`);
      assertStringIncludes(result.stdout, `\nmodel: ${model}\n`);
      assertStringIncludes(result.stdout, "완료");
    }
  }
});

Deno.test("Herdr에서도 선택한 CLI가 없으면 설치된 에이전트로 시작하고 둘 다 없으면 패널을 만들지 않는다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  const test = setup(dir.path, "작업", [
    ...completedUntilPostProcessing(codexPath(dir.path), `${prefix}작업`),
    ...successfulCleanup(),
  ], {
    installed: ["codex"],
    env: { HERDR_ENV: "1", CODEX_THREAD_ID: "caller" },
  });
  const result = await runDelegate(["prompt", "--agent", "claude"], test.deps);
  assertEquals(result.code, 0, result.stdout);
  assertStringIncludes(result.stdout, "code: agent_fallback");
  assertStringIncludes(result.stdout, "\nagent: codex\n");
  const start = test.fake.calls.find((call) => call.args[1] === "start")!;
  assertEquals(start.args[start.args.indexOf("--kind") + 1], "codex");

  for (const transport of ["direct", "herdr"]) {
    const absent = setup(dir.path, "작업", [], {
      installed: [],
      env: { HERDR_ENV: "1", CODEX_THREAD_ID: "caller" },
    });
    const failed = await runDelegate(
      ["prompt", "--transport", transport],
      absent.deps,
    );
    assertEquals(failed.code, 5);
    assertStringIncludes(failed.stdout, "code: agent_failed");
    assertStringIncludes(failed.stdout, "codex");
    assertStringIncludes(failed.stdout, "claude");
    assertEquals(absent.fake.calls, []);
  }
});

Deno.test("대체한 에이전트가 실패해도 대체 사유를 남기고 기존 세션은 다른 에이전트로 넘기지 않는다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  for (const transport of ["direct", "herdr"]) {
    const test = setup(dir.path, "작업", [
      transport === "direct"
        ? { cmd: "codex", code: 1, stderr: "execution failed" }
        : herdrFailure("execution failed"),
    ], {
      installed: ["codex"],
      env: { HERDR_ENV: "1", CODEX_THREAD_ID: "caller" },
    });
    const result = await runDelegate([
      "prompt",
      "--agent",
      "claude",
      "--transport",
      transport,
    ], test.deps);
    assertEquals(result.code, transport === "direct" ? 5 : 3);
    assertStringIncludes(result.stdout, "execution failed");
    assertStringIncludes(result.stdout, "code: agent_fallback");
    assertEquals(test.fake.calls.length, 1);
  }

  writeJsonl(codexPath(dir.path), [codexMeta(), ...codexTurn("old", "old")]);
  const resume = setup(dir.path, "후속", [{
    cmd: "codex",
    onStart: () => {
      throw new Deno.errors.NotFound("missing codex");
    },
  }], { installed: ["claude"] });
  const resumed = await runDelegate(["prompt", codexId], resume.deps);
  assertEquals(resumed.code, 5);
  assertStringIncludes(resumed.stdout, "missing codex");
  assertEquals(resumed.stdout.includes("agent_fallback"), false);
  assertEquals(resume.fake.calls.map((call) => call.cmd), ["codex"]);
});

Deno.test({
  name: "윈도에서 실행 경로를 따옴표로 감싸도 설치된 CLI로 작업을 마친다",
  ignore: Deno.build.os !== "windows",
  async fn() {
    await using dir = await createTempDir({ prefix: "delegate test " });
    const test = setup(dir.path, "작업", [directReply("codex")]);
    const env: Record<string, string> = { ...test.deps.env };
    env.Path = `"${env.PATH}"`;
    delete env.PATH;
    const result = await runDelegate(["prompt", "--agent", "codex"], {
      ...test.deps,
      env,
    });
    assertEquals(result.code, 0, result.stdout);
    assertEquals(result.stdout.includes("agent_fallback"), false);
    assertEquals(test.fake.calls.map((call) => call.cmd), ["codex"]);
  },
});

Deno.test({
  name:
    "윈도 셸용 CLI는 Herdr에서 그대로 실행하고 직접 실행에서는 실행 가능한 에이전트를 고른다",
  ignore: Deno.build.os !== "windows",
  async fn() {
    await using dir = await createTempDir({ prefix: "delegate-test-" });
    for (const extension of [".cmd", ".ps1"]) {
      for (const transport of ["herdr", "direct"]) {
        const test = setup(
          dir.path,
          "작업",
          transport === "direct" ? [directReply("claude")] : [
            ...completedUntilPostProcessing(
              codexPath(dir.path),
              `${prefix}작업`,
            ),
            ...successfulCleanup(),
          ],
          {
            installed: ["claude"],
            env: { HERDR_ENV: "1", CODEX_THREAD_ID: "caller" },
          },
        );
        Deno.writeTextFileSync(
          join(test.deps.env.PATH, `codex${extension}`),
          "",
        );
        const result = await runDelegate([
          "prompt",
          "--agent",
          "codex",
          "--transport",
          transport,
        ], test.deps);
        assertEquals(result.code, 0, result.stdout);
        assertEquals(
          result.stdout.includes("agent_fallback"),
          transport === "direct",
        );
        assertStringIncludes(
          result.stdout,
          `\nagent: ${transport === "direct" ? "claude" : "codex"}\n`,
        );
      }
    }
  },
});

Deno.test("직접 실행이 시작되지 않거나 제한 시간 초과·취소로 끝나면 실패 원인과 확인된 세션을 알린다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  const failed = setup(dir.path, "작업", [{
    cmd: "codex",
    onStart: () => {
      throw new Deno.errors.NotFound("missing");
    },
  }]);
  const spawn = await runDelegate([
    "prompt",
    "--transport",
    "direct",
    "--agent",
    "codex",
  ], failed.deps);
  assertEquals(spawn.code, 5);
  assertStringIncludes(spawn.stdout, "code: agent_failed");

  const timeout = setup(dir.path, "작업", [{
    cmd: "codex",
    waitForAbort: true,
    stdout: `{"type":"thread.started","thread_id":"${codexId}"}\n`,
  }]);
  const timedOut = await runDelegate([
    "prompt",
    "--transport",
    "direct",
    "--agent",
    "codex",
    "--timeout",
    "1ms",
  ], timeout.deps);
  assertEquals(timedOut.code, 6);
  assertStringIncludes(timedOut.stdout, "code: timeout");
  assertStringIncludes(timedOut.stdout, codexId);

  const controller = new AbortController();
  const cancelled = setup(dir.path, "작업", [{
    cmd: "codex",
    waitForAbort: true,
    stdout: `{"type":"thread.started","thread_id":"${codexId}"}\n`,
    onStart: () => controller.abort(),
  }], { signal: controller.signal });
  const interrupted = await runDelegate([
    "prompt",
    "--transport",
    "direct",
    "--agent",
    "codex",
  ], cancelled.deps);
  assertEquals(interrupted.code, 130);
  assertStringIncludes(interrupted.stdout, "code: cancelled");
  assertStringIncludes(interrupted.stdout, codexId);
});

Deno.test("직접 요청의 비정상 종료와 불완전 출력도 먼저 관찰한 세션과 실패 상태를 보존한다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  for (const agent of ["codex", "claude"] as const) {
    const id = agent === "codex" ? codexId : claudeId;
    const event = agent === "codex"
      ? { type: "thread.started", thread_id: id }
      : { type: "system", subtype: "init", session_id: id };
    const progress: string[] = [];
    const test = setup(dir.path, "작업", [{
      cmd: agent,
      code: 1,
      stdoutChunks: [line(event), '{"type":'],
    }]);
    const result = await runDelegate(["prompt", "--agent", agent], {
      ...test.deps,
      progress: (text) => {
        progress.push(text);
      },
    });
    assertEquals(result.code, 5);
    assertStringIncludes(result.stdout, id);
    assertStringIncludes(result.stdout, "code: agent_failed");
    assertEquals(progress.length, 1);
  }
});

// Codex logs

Deno.test("코덱스 로그에서 완료·취소·미완료 요청과 공개 활동을 확인하고 부분 기록과 민감한 내용을 구별한다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  const path = codexPath(dir.path);
  writeJsonl(path, [
    codexMeta(),
    ...codexTurn("old", "이전 요청", "이전 답변"),
    ...codexTurn("aborted", "취소 요청", undefined, "aborted"),
    ...codexTurn("new", "새 요청"),
    {
      type: "response_item",
      timestamp: "2026-09-22T01:02:03Z",
      payload: {
        type: "function_call",
        name: "exec_command",
        arguments: "secret-argument",
      },
    },
    {
      type: "response_item",
      timestamp: "2026-09-22T01:02:04Z",
      payload: { type: "reasoning", summary: "private-reasoning" },
    },
  ], '{"type":"event_msg"');
  for (const herdrEnv of [false, true]) {
    const test = setup(dir.path, "", herdrEnv ? [herdr({ agents: [] })] : [], {
      env: {
        ...(herdrEnv ? { HERDR_ENV: "1" } : {}),
        OS: "Windows_NT",
        USERPROFILE: join(dir.path, "other-profile"),
      },
    });
    const status = await runDelegate(["status", codexId], test.deps);
    assertEquals(status.code, 0);
    assertStringIncludes(status.stdout, "activity: unknown");
    assertStringIncludes(status.stdout, "request_state: incomplete");
    assertStringIncludes(status.stdout, "2026-09-22T01:02:04Z");
    const logs = await runDelegate(["logs", codexId], test.deps);
    assertEquals(logs.code, 0);
    assertStringIncludes(logs.stdout, "tool_started");
    assertStringIncludes(logs.stdout, "exec_command");
    assertStringIncludes(logs.stdout, "partial_record: true");
    assertStringIncludes(logs.stdout, "이전 요청");
    assertStringIncludes(logs.stdout, "이전 답변");
    assertStringIncludes(logs.stdout, "취소 요청");
    assertEquals(logs.stdout.includes("bootstrap은 무시"), false);
    assertEquals(logs.stdout.includes("secret"), false);
    assertStringIncludes(logs.stdout, "새 요청");
    assertEquals(logs.stdout.includes("secret-argument"), false);
    assertEquals(logs.stdout.includes("private-reasoning"), false);
  }
});

// Claude logs

Deno.test("클로드 로그에서 사람의 요청과 최종 답변·공개 도구 활동을 확인하고 중간 설명과 민감한 내용은 제외한다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  const path = claudePath(dir.path);
  const records = [{
    type: "user",
    sessionId: claudeId,
    cwd,
    uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    origin: { kind: "human" },
    promptSource: "typed",
    userType: "external",
    isSidechain: false,
    message: { role: "user", content: `${prefix}클로드 요청` },
  }, {
    type: "assistant",
    sessionId: claudeId,
    cwd,
    requestId: "req-tool",
    isSidechain: false,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "중간 설명" }, {
        type: "tool_use",
        id: "tool-1",
        name: "Read",
        input: "secret-argument",
      }],
    },
  }, {
    type: "user",
    sessionId: claudeId,
    cwd,
    uuid: "tool-result",
    toolUseResult: { value: "secret" },
    message: {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "tool-1",
        content: "secret-output",
      }],
    },
  }, {
    type: "assistant",
    sessionId: claudeId,
    cwd,
    requestId: "req-final",
    isSidechain: false,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "최종 답변" }],
    },
  }, {
    type: "system",
    subtype: "turn_duration",
    sessionId: claudeId,
    cwd,
    timestamp: "2026-09-16T00:00:01Z",
  }];
  const test = setup(dir.path, "");
  writeJsonl(path, records.slice(0, 3));
  const active = await runDelegate(["logs", claudeId], test.deps);
  assertEquals(active.code, 0);
  assertStringIncludes(active.stdout, "tool_completed");
  assertStringIncludes(active.stdout, "Read");
  assertEquals(active.stdout.includes("중간 설명"), false);
  assertEquals(active.stdout.includes("secret"), false);

  appendJsonl(path, records.slice(3));
  const logs = await runDelegate(["logs", claudeId], test.deps);
  assertEquals(logs.code, 0);
  assertStringIncludes(logs.stdout, "agent: claude");
  assertStringIncludes(logs.stdout, "클로드 요청");
  assertStringIncludes(logs.stdout, "최종 답변");
  assertEquals(logs.stdout.includes("중간 설명"), false);
  assertEquals(logs.stdout.includes("secret"), false);
});

Deno.test("진행 중인 클로드 작업에 후속 요청을 보내면 진행 중인 턴에 합쳐져도 후속 결과를 받고 첫 요청 기록을 남긴다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  const path = claudePath(dir.path);
  writeJsonl(path, claudeOpen(`${prefix}첫 요청`));
  let now = 0;
  let followUpWritten = false;
  const queued = (kind: string, prompt: string) => ({
    type: "attachment",
    sessionId: claudeId,
    cwd,
    attachment: {
      type: "queued_command",
      commandMode: kind === "human" ? "prompt" : kind,
      origin: { kind },
      prompt,
    },
  });
  const test = setup(dir.path, "후속 요청", [
    herdr({ agents: [claudeLive("working", 1)] }),
    herdr({ agent: currentClaude("working", 2) }),
    herdr({ agent: claudeLive("done", 3) }),
    herdr({ agent: claudeLive("done", 3) }),
    herdr({}),
  ], {
    env: { HERDR_ENV: "1" },
    now: () => now,
    sleep: (ms) => {
      now += ms;
      if (!followUpWritten && now > 5_000) {
        appendJsonl(path, [
          queued("task-notification", "<task-notification>작업 완료"),
          queued("human", `${prefix}후속 요청`),
          {
            type: "assistant",
            sessionId: claudeId,
            cwd,
            requestId: "req-follow-up",
            message: { content: [{ type: "text", text: "후속 결과" }] },
          },
          { type: "system", subtype: "turn_duration", sessionId: claudeId },
        ]);
        followUpWritten = true;
      }
      return Promise.resolve();
    },
  });

  const prompted = await runDelegate([
    "prompt",
    claudeId,
    "--caller-id",
    "caller-1",
    "--timeout",
    "60s",
  ], test.deps);
  assertEquals(prompted.code, 0);
  assertStringIncludes(prompted.stdout, "후속 결과");
  assertEquals(prompted.stdout.includes("intervening_prompts:"), false);

  const logs = await runDelegate(["logs", claudeId], test.deps);
  assertStringIncludes(logs.stdout, "첫 요청");
  assertStringIncludes(logs.stdout, "후속 요청");
  assertEquals(logs.stdout.includes("task-notification"), false);
});

// Status

Deno.test("윈도에서 홈과 사용자 프로필이 달라도 기본 프로필에 기록된 세션의 상태를 확인한다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  const home = join(dir.path, "home");
  const profile = join(dir.path, "profile");
  const path = join(
    profile,
    ".codex",
    "sessions",
    "2026",
    "09",
    "16",
    `rollout-anon-${codexId}.jsonl`,
  );
  writeJsonl(path, [
    codexMeta(),
    ...codexTurn("turn-1", "사람 요청", "최종 답변"),
  ]);
  const base = setup(dir.path, "");
  const env: Record<string, string> = {
    ...base.deps.env,
    OS: "Windows_NT",
    HOME: home,
    USERPROFILE: profile,
  };
  delete env.CODEX_HOME;

  const result = await runDelegate(["status", codexId], {
    ...base.deps,
    env,
  });

  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, `session_id: ${codexId}`);
  assertStringIncludes(result.stdout, "agent: codex");
});

Deno.test("세션 식별자나 기록이 잘못되거나 저장 위치 밖을 가리키거나 후보가 여럿이면 상태 조회를 거부한다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  const env = setup(dir.path, "").deps.env;
  const invalid = await runDelegate(
    ["status", "not-a-session"],
    setup(dir.path, "").deps,
  );
  assertEquals(invalid.code, 2);
  assertStringIncludes(invalid.stdout, "code: invalid_session_id");

  writeJsonl(codexPath(dir.path), [codexMeta()]);
  Deno.writeTextFileSync(codexPath(dir.path), "not-json\n", { append: true });
  const corrupt = await runDelegate(
    ["status", codexId],
    setup(dir.path, "").deps,
  );
  assertEquals(corrupt.code, 5);
  assertStringIncludes(corrupt.stdout, "code: invalid_native_session");

  Deno.removeSync(join(dir.path, "codex"), { recursive: true });
  const outside = join(dir.path, "outside.jsonl");
  writeJsonl(outside, [codexMeta()]);
  const linked = codexPath(dir.path);
  Deno.mkdirSync(join(linked, ".."), { recursive: true });
  Deno.symlinkSync(outside, linked);
  const unsafe = await runDelegate(
    ["status", codexId],
    setup(dir.path, "").deps,
  );
  assertEquals(unsafe.code, 5);
  assertStringIncludes(unsafe.stdout, "code: unsafe_native_path");

  Deno.removeSync(join(dir.path, "codex"), { recursive: true });
  writeJsonl(codexPath(dir.path), [codexMeta()]);
  writeJsonl(
    join(
      dir.path,
      "codex",
      "sessions",
      "other",
      `rollout-other-${codexId}.jsonl`,
    ),
    [codexMeta()],
  );
  const ambiguous = await runDelegate(
    ["status", codexId],
    setup(dir.path, "").deps,
  );
  assertEquals(ambiguous.code, 5);
  assertStringIncludes(ambiguous.stdout, "code: session_ambiguous");
  assertEquals(env.CODEX_HOME, join(dir.path, "codex"));
});

Deno.test("기록 없는 세션을 조회하거나 재개하면 연결이 확인된 허더 패널의 화면만 보여준다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  const direct = setup(dir.path, "작업", [], { env: { HERDR_ENV: "1" } });
  const directResult = await runDelegate([
    "prompt",
    claudeId,
    "--transport",
    "direct",
  ], direct.deps);
  assertStringIncludes(directResult.stdout, "code: session_not_found");
  assertEquals(direct.fake.calls.length, 0);
  for (
    const live of [
      {
        ...claudeLive("blocked", 1),
        name: `dlg-${claudeId.replaceAll("-", "").slice(0, 27)}x`,
      },
      { ...claudeLive("blocked", 1), cwd: "/other-workspace" },
    ]
  ) {
    const test = setup(dir.path, "", [herdr({ agents: [live] })], {
      env: { HERDR_ENV: "1" },
    });
    const result = await runDelegate(["status", claudeId], test.deps);
    assertStringIncludes(result.stdout, "code: session_not_found");
    assertEquals(result.stdout.includes("pane_id:"), false);
  }
  const mismatched = setup(dir.path, "", [
    herdr({ agents: [claudeLive("blocked", 1)] }),
    herdr({
      agent: {
        ...claudeLive("blocked", 1),
        name: "unrelated-agent",
        pane_id: "another-pane",
      },
    }),
  ], { env: { HERDR_ENV: "1" } });
  const mismatch = await runDelegate(["status", claudeId], mismatched.deps);
  assertStringIncludes(mismatch.stdout, "code: session_not_found");
  assertEquals(
    mismatched.fake.calls.some((call) => call.args[1] === "read"),
    false,
  );

  const missingButWrong = setup(dir.path, "", [
    herdr({ agents: [claudeLive("blocked", 1)] }),
    herdr({
      agent: {
        name: "unrelated-agent",
        agent_kind: "claude",
        cwd,
        agent_status: "blocked",
      },
    }),
  ], { env: { HERDR_ENV: "1" } });
  const wrong = await runDelegate(["status", claudeId], missingButWrong.deps);
  assertStringIncludes(wrong.stdout, "code: session_not_found");
  assertEquals(
    missingButWrong.fake.calls.some((call) =>
      call.args[0] === "pane" && ["get", "read"].includes(call.args[1] ?? "")
    ),
    false,
  );

  const unreadable = setup(dir.path, "", [
    herdr({ agents: [claudeLive("blocked", 1)] }),
    herdr({ agent: claudeLive("blocked", 1) }),
    herdrError("pane_failed", "read refused"),
  ], { env: { HERDR_ENV: "1" } });
  const unread = await runDelegate(["status", claudeId], unreadable.deps);
  assertStringIncludes(unread.stdout, "code: agent_blocked");
  assertStringIncludes(unread.stdout, "pane_id: pane-delegate");
  assertEquals(unread.stdout.includes("read refused"), false);
});

// Wait

Deno.test("응답을 기다리다 차단되면 요청을 다시 보내지 않고 연결된 패널의 화면을 보여준다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  writeJsonl(codexPath(dir.path), [
    codexMeta(),
    ...codexTurn("open", "승인 필요"),
  ]);
  const test = setup(dir.path, "", [
    herdr({ agents: [liveAgent("working", 1)] }),
    herdr({ agent: liveAgent("blocked", 2) }),
    herdr({ agents: [liveAgent("blocked", 2)] }),
    herdr({ agent: { ...liveAgent("blocked", 2), pane_id: "pane-moved" } }),
    { cmd: "herdr", stdout: "Wait for approval\n" },
  ], { env: { HERDR_ENV: "1" } });
  const result = await runDelegate(["wait", codexId], test.deps);
  assertEquals(result.code, 4);
  assertStringIncludes(result.stdout, "pane_id: pane-moved");
  assertEquals(
    test.fake.calls.some((call) =>
      call.args.join(" ") === "pane read pane-moved --source visible"
    ),
    true,
  );
  assertStringIncludes(result.stdout, "Wait for approval");
  assertEquals(
    test.fake.calls.some((call) =>
      ["prompt", "close"].includes(call.args[1] ?? "")
    ),
    false,
  );
});

Deno.test("직접 대기는 이전 답변을 반환하지 않고 부분 기록이 완성된 최신 요청 결과를 기다린다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  const path = codexPath(dir.path);
  writeJsonl(path, [
    codexMeta(),
    ...codexTurn("old", "이전 요청", "이전 답변"),
    ...codexTurn("new", "새 요청").slice(0, 2),
  ], '{"type":"turn_context"');
  let sleeps = 0;
  let now = 0;
  const test = setup(dir.path, "", [], {
    now: () => now,
    sleep: (ms) => {
      now += ms;
      sleeps++;
      if (sleeps === 2) {
        writeJsonl(path, [
          codexMeta(),
          ...codexTurn("old", "이전 요청", "이전 답변"),
          ...codexTurn("new", "새 요청", "새 답변"),
        ]);
      }
      return Promise.resolve();
    },
  });
  const result = await runDelegate(
    ["wait", codexId, "--timeout", "2s"],
    test.deps,
  );
  assertEquals(result.code, 0);
  assertEquals(sleeps, 2);
  assertStringIncludes(result.stdout, "새 답변");
  assertEquals(result.stdout.includes("이전 답변"), false);
  assertEquals(result.stdout.includes("intervening_prompts"), false);
  assertStringIncludes(result.stdout, "activity: unknown");
});

Deno.test("대기 중 같은 기록 파일을 잘랐다가 더 길게 다시 써도 교체 요청의 결과를 반환하지 않는다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  const path = codexPath(dir.path);
  writeJsonl(path, [codexMeta(), ...codexTurn("target", "원래 요청")]);
  const before = Deno.statSync(path);
  let now = 0;
  const test = setup(dir.path, "", [], {
    now: () => now,
    sleep: (ms) => {
      now += ms;
      Deno.truncateSync(path, 0);
      appendJsonl(path, [
        codexMeta(),
        ...codexTurn("target", "교체 요청", "반환하면 안 되는 교체 결과"),
      ]);
      const after = Deno.statSync(path);
      assertEquals(after.ino, before.ino);
      assertEquals(after.size > before.size, true);
      return Promise.resolve();
    },
  });
  const result = await runDelegate(
    ["wait", codexId, "--timeout", "1s"],
    test.deps,
  );
  assertEquals(result.code, 5);
  assertStringIncludes(result.stdout, "code: invalid_native_session");
  assertEquals(result.stdout.includes("반환하면 안 되는 교체 결과"), false);
});

Deno.test("클로드 작업을 기다리면서 이름을 지정하면 허더와 직접 실행 모두 사용법 오류를 알린다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  writeJsonl(claudePath(dir.path), [
    ...claudeOpen("요청"),
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "답변" }] },
    },
    { type: "system", subtype: "turn_duration" },
  ]);
  for (const herdrEnv of [true, false]) {
    const test = setup(dir.path, "", [], {
      env: herdrEnv ? { HERDR_ENV: "1" } : {},
    });
    const result = await runDelegate(
      ["wait", claudeId, "--name", "검토"],
      test.deps,
    );
    assertEquals(result.code, 2, herdrEnv ? "Herdr" : "직접 실행");
    assertStringIncludes(result.stdout, "code: usage");
    assertStringIncludes(
      result.stdout,
      "Claude wait에는 --name을 사용할 수 없습니다",
    );
    assertEquals(test.fake.calls, []);
  }
});

Deno.test("직접 대기는 중단 기록과 호출자 취소를 구별하고 종료 근거 없는 기록은 시간 제한까지 기다린다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  const path = codexPath(dir.path);
  for (
    const scenario of [
      "aborted",
      "cancelled",
      "silent",
      "partial",
      "partial_after_abort",
    ] as const
  ) {
    writeJsonl(
      path,
      [
        codexMeta(),
        ...codexTurn(
          "new",
          "새 요청",
          undefined,
          scenario === "aborted" || scenario === "partial_after_abort"
            ? "aborted"
            : "open",
        ),
      ],
      scenario === "partial" || scenario === "partial_after_abort"
        ? '{"type":"event_msg","payload":{"type":"task_complete"'
        : "",
    );
    let now = 0;
    const controller = new AbortController();
    const test = setup(dir.path, "", [], {
      signal: controller.signal,
      now: () => now,
      sleep: (ms) => {
        now += ms;
        if (scenario === "cancelled") {
          controller.abort();
          return Promise.reject(new DOMException("Aborted", "AbortError"));
        }
        return Promise.resolve();
      },
    });
    const result = await runDelegate(
      ["wait", codexId, "--timeout", "1s"],
      test.deps,
    );
    assertEquals(
      result.code,
      scenario === "aborted" || scenario === "cancelled" ? 130 : 6,
      scenario,
    );
    assertStringIncludes(result.stdout, codexId);
    if (scenario === "silent" || scenario === "partial") {
      assertEquals(
        now,
        1_000,
      );
    }
  }
});

Deno.test("창 없는 클로드 세션을 기다리면 새 요청 뒤 추가 요청까지 마친 최신 결과를 받는다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  const path = claudePath(dir.path);
  const completed = [
    ...claudeOpen("이전 요청"),
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "이전 답변" }] },
    },
    { type: "system", subtype: "turn_duration" },
  ];
  writeJsonl(path, completed, '{"type":"user"');
  let now = 0;
  const test = setup(dir.path, "", [herdr({ agents: [] })], {
    env: { HERDR_ENV: "1" },
    now: () => now,
    sleep: (ms) => {
      now += ms;
      writeJsonl(path, [
        ...completed,
        ...claudeOpen("새 요청"),
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "새 답변" }] },
        },
        { type: "system", subtype: "turn_duration" },
        { ...claudeOpen("추가 요청")[0], promptSource: "queued" },
        {
          type: "assistant",
          message: {
            content: [{
              type: "tool_use",
              id: "call",
              name: "Read",
              input: "secret-argument",
            }],
          },
        },
        {
          type: "user",
          message: {
            content: [{
              type: "tool_result",
              tool_use_id: "call",
              content: "secret-output",
            }],
          },
        },
      ]);
      if (now >= 500) {
        appendJsonl(path, [
          {
            type: "assistant",
            message: { content: [{ type: "text", text: "추가 답변" }] },
          },
          { type: "system", subtype: "turn_duration" },
        ]);
      }
      return Promise.resolve();
    },
  });
  const result = await runDelegate(
    ["wait", claudeId, "--timeout", "2s"],
    test.deps,
  );
  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, "추가 답변");
  assertStringIncludes(result.stdout, "intervening_prompts:\n  - 추가 요청");
  assertEquals(result.stdout.includes("이전 답변"), false);
  assertEquals(now, 500);
});

// Close

Deno.test("실행 중인 세션을 닫으면 작업을 취소한 뒤 해당 패널만 닫는다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  writeJsonl(codexPath(dir.path), [codexMeta(), ...codexTurn("old", "old")]);
  const live = liveAgent("working", 1);
  const test = setup(dir.path, "", [
    herdr({ agents: [live] }),
    herdr({}),
    herdr({
      agent: {
        ...liveAgent("idle", 2),
        workspace_id: "ws-2",
        tab_id: "tab-moved",
        pane_id: "pane-moved",
      },
    }),
    herdr({}),
  ], { env: { HERDR_ENV: "1" } });

  const result = await runDelegate(["close", codexId], test.deps);

  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, "activity: not_live");
  assertEquals(test.fake.calls.map((call) => call.args), [
    ["agent", "list"],
    ["agent", "send-keys", live.name, "ctrl+c"],
    ["agent", "get", live.name],
    ["pane", "close", "pane-moved"],
  ]);
});

Deno.test("다른 작업의 정리가 끝나지 않으면 닫기 요청은 60초 뒤 제한 시간 초과를 알린다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  writeJsonl(codexPath(dir.path), [
    codexMeta(),
    ...codexTurn("old", "old", "done"),
  ]);
  const socketPath = join(dir.path, "herdr.sock");
  const lock = await Deno.open(`${socketPath}.delegate-pane.lock`, {
    create: true,
    read: true,
    write: true,
  });
  await lock.lock(true);
  let now = 0;
  const test = setup(dir.path, "", [
    herdr({ agents: [liveAgent("done", 1)] }),
  ], {
    env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath },
    now: () => now,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
  });

  try {
    const result = await runDelegate(["close", codexId], test.deps);
    assertEquals(result.code, 6);
    assertStringIncludes(result.stdout, "code: timeout");
    assertEquals(now, 60_000);
  } finally {
    await lock.unlock();
    lock.close();
  }
});

Deno.test("직접 실행을 제어할 수 없는 닫기 요청은 지원 범위를 알리는 오류를 반환한다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  writeJsonl(codexPath(dir.path), [
    codexMeta(),
    ...codexTurn("new", "새 요청"),
  ]);
  for (const herdrEnv of [false, true]) {
    const test = setup(dir.path, "", herdrEnv ? [herdr({ agents: [] })] : [], {
      env: herdrEnv ? { HERDR_ENV: "1" } : {},
    });
    const result = await runDelegate(["close", codexId], test.deps);
    assertEquals(result.code, 3);
    assertStringIncludes(result.stdout, "code: transport_unavailable");
    assertStringIncludes(result.stdout, "Herdr");
  }
});

Deno.test("패널 부재 메시지가 정확히 일치할 때만 세션을 한 번 재조회하고 두 번째 닫기 실패를 알린다", async (t) => {
  for (const command of ["prompt", "wait", "close"] as const) {
    for (
      const scenario of [
        "gone",
        "moved",
        "refused",
        "different-message",
        "retry-missing",
        "retry-refused",
        "list-failed",
        "identity-changed",
        "cancelled",
        "timeout",
      ] as const
    ) {
      await t.step(`${command}: ${scenario}`, async () => {
        await using dir = await createTempDir({ prefix: "delegate-test-" });
        const path = codexPath(dir.path);
        writeJsonl(path, [
          codexMeta(),
          ...codexTurn("t", `${prefix}작업`, "완료"),
        ]);
        let now = 0;
        const controller = new AbortController();
        const moved = {
          ...liveAgent("done", 2),
          name: "user-renamed-agent",
          workspace_id: "ws-2",
          tab_id: "tab-moved",
          pane_id: "pane-moved",
        };
        const firstMessage = scenario === "refused"
          ? "pane close refused"
          : scenario === "different-message"
          ? "pane pane-delegate not found elsewhere"
          : "pane pane-delegate not found";
        const retry = ["moved", "retry-missing", "retry-refused"].includes(
          scenario,
        );
        const requery = !["refused", "different-message"].includes(scenario);
        const failure = scenario === "retry-missing"
          ? "pane pane-moved not found"
          : scenario === "retry-refused"
          ? "retry close refused"
          : scenario === "list-failed"
          ? "list refused"
          : firstMessage;
        const responses = [
          ...(command === "prompt"
            ? completedUntilPostProcessing(path, `${prefix}작업`)
            : command === "wait"
            ? [
              herdr({ agents: [liveAgent("done", 2)] }),
              herdr({ agent: liveAgent("done", 2) }),
              herdr({ agent: liveAgent("done", 2) }),
            ]
            : [herdr({ agents: [liveAgent("done", 2)] })]),
          herdrError(
            scenario === "refused" ? "herdr_failed" : "pane_not_found",
            firstMessage,
          ),
          ...(requery
            ? [
              scenario === "list-failed" ? herdrFailure(failure) : herdr({
                agents: scenario === "gone" ? [] : [{
                  ...moved,
                  ...(scenario === "identity-changed"
                    ? {
                      name: liveAgent("done", 2).name,
                      agent_session: { kind: "id", value: claudeId },
                    }
                    : {}),
                }],
              }, {
                onStart: () => {
                  if (scenario === "cancelled") controller.abort();
                  if (scenario === "timeout") now += 60_000;
                },
              }),
            ]
            : []),
          ...(retry
            ? [
              scenario === "moved" ? herdr({}) : herdrError(
                scenario === "retry-missing"
                  ? "pane_not_found"
                  : "herdr_failed",
                failure,
              ),
            ]
            : []),
        ];
        const test = setup(dir.path, "작업", responses, {
          env: { HERDR_ENV: "1", CODEX_THREAD_ID: "caller" },
          signal: controller.signal,
          now: () => now,
          sleep: (ms) => {
            now += ms;
            return Promise.resolve();
          },
        });
        const result = await runDelegate(
          command === "prompt"
            ? [
              "prompt",
              "--agent",
              "codex",
              "--caller-id",
              "caller",
              "--timeout",
              "60s",
            ]
            : command === "wait"
            ? ["wait", codexId, "--timeout", "60s"]
            : ["close", codexId],
          test.deps,
        );
        const success = scenario === "gone" || scenario === "moved";
        assertEquals(
          result.code,
          scenario === "cancelled"
            ? 130
            : scenario === "timeout"
            ? 6
            : command === "close" && !success
            ? 5
            : 0,
        );
        if (success) {
          assertStringIncludes(
            result.stdout,
            `activity: ${command === "close" ? "not_live" : "quiescent"}`,
          );
          assertEquals(result.stdout.includes("warnings:"), false);
        } else if (scenario === "cancelled" || scenario === "timeout") {
          assertStringIncludes(result.stdout, `code: ${scenario}`);
        } else if (scenario === "identity-changed") {
          assertStringIncludes(
            result.stdout,
            `code: ${
              command === "close" ? "session_id_changed" : "cleanup_failed"
            }`,
          );
        } else {
          assertStringIncludes(
            result.stdout,
            `code: ${
              command === "close" && scenario === "list-failed"
                ? "live_session_ambiguous"
                : "cleanup_failed"
            }`,
          );
          assertStringIncludes(result.stdout, failure);
        }
        if (
          command !== "close" && !["cancelled", "timeout"].includes(scenario)
        ) {
          assertStringIncludes(result.stdout, "\n\n완료\n");
        }
        const firstClose = test.fake.calls.findIndex((call) =>
          call.args[0] === "pane" && call.args[1] === "close"
        );
        assertEquals(
          test.fake.calls.slice(firstClose).map((call) => call.args),
          [
            ["pane", "close", "pane-delegate"],
            ...(requery ? [["agent", "list"]] : []),
            ...(retry ? [["pane", "close", "pane-moved"]] : []),
          ],
        );
      });
    }
  }
});

// Help / usage / process

Deno.test("스킬 출력을 요청하면 현재 CLI 주소로 실행하는 완전한 스킬 문서를 받는다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  const test = setup(dir.path, "");

  const result = await runDelegate(["--skill"], test.deps);

  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, "name: delegate");
  assertStringIncludes(
    result.stdout,
    `deno run -A ${
      new URL("./delegate.ts", import.meta.url).href
    } prompt --help`,
  );
  assertEquals(result.stdout.includes("{SKILL_BASE_DIR}"), false);
  assertEquals(test.fake.calls, []);
});

Deno.test("시작 차단 도움말은 키 입력 명령과 pane 화면·기록 부재를 안내한다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  const result = await runDelegate(
    ["prompt", "--help"],
    setup(dir.path, "").deps,
  );

  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, "error.pane.pane_id");
  assertEquals(result.stdout.includes("코덱스 샌드박스 권한 허용"), false);
  assertEquals(result.stdout.includes("메인 세션"), false);
  assertEquals(result.stdout.includes("herdr pane read"), false);
  assertStringIncludes(
    result.stdout,
    "herdr pane send-keys <PANE_ID> <KEY>...",
  );
  assertStringIncludes(
    result.stdout,
    "native 기록 파일은 아직 없을 수 있음",
  );
  assertStringIncludes(
    result.stdout,
    "차단 해소 뒤에도 native 기록 파일이 없을 수 있으므로",
  );
  assertEquals(
    result.stdout.includes("native session UUID가 있으면 wait"),
    false,
  );
});

Deno.test("삭제된 명령과 옵션·위치 prompt는 실행 전에 거부된다", async () => {
  await using dir = await createTempDir({ prefix: "delegate-test-" });
  const base = setup(dir.path, "작업");
  for (
    const args of [
      ["run"],
      ["resume", codexId],
      ["prompt", "위치 본문", "추가 본문"],
      ["prompt", "--keep"],
      ["prompt", "--confirm-escalation"],
      ["close", codexId, "--caller-id", "caller"],
    ]
  ) {
    const result = await runDelegate(args, base.deps);
    assertEquals(result.code, 2);
    assertStringIncludes(result.stdout, "code: usage");
  }
  assertEquals(base.fake.calls, []);
});

Deno.test("공개 오류는 명세의 종료 코드로만 매핑된다", () => {
  const cases = {
    usage: 2,
    invalid_session_id: 2,
    live_option_conflict: 2,
    transport_unavailable: 3,
    caller_session_unavailable: 3,
    session_not_found: 3,
    session_ambiguous: 5,
    live_session_ambiguous: 5,
    session_id_unavailable: 5,
    session_id_changed: 5,
    unsafe_native_path: 5,
    invalid_native_session: 5,
    agent_failed: 5,
    herdr_failed: 5,
    agent_blocked: 4,
    cleanup_failed: 5,
    timeout: 6,
    cancelled: 130,
  } as const;
  for (const [code, expected] of Object.entries(cases)) {
    assertEquals(exitCode(code as keyof typeof cases), expected);
  }
});

Deno.test("자식이 stdin을 읽기 전에 종료돼도 stdout과 종료 상태를 회수한다", async () => {
  const chunks: string[] = [];
  const result = await denoExec("git", ["--version"], {
    cwd: Deno.cwd(),
    env: { PATH: Deno.env.get("PATH") ?? "" },
    stdin: "x".repeat(1_000_000),
    onStdout: (chunk) => {
      chunks.push(chunk);
    },
  });
  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, "git version");
  assertEquals(chunks.join(""), result.stdout);
});

function setup(
  root: string,
  prompt: string,
  responses: readonly FakeResponse[] = [],
  options: {
    installed?: readonly ("codex" | "claude")[];
    env?: Record<string, string>;
    signal?: AbortSignal;
    now?: () => number;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  } = {},
) {
  const fake = fakeExec(responses);
  const bin = Deno.makeTempDirSync({ dir: root, prefix: "bin-" });
  for (const agent of options.installed ?? ["codex", "claude"]) {
    const path = join(
      bin,
      Deno.build.os === "windows" ? `${agent}.exe` : agent,
    );
    Deno.writeTextFileSync(path, "");
    if (Deno.build.os !== "windows") Deno.chmodSync(path, 0o755);
  }
  return {
    fake,
    deps: {
      exec: fake.exec,
      env: {
        PATH: bin,
        HOME: root,
        CODEX_HOME: join(root, "codex"),
        CLAUDE_CONFIG_DIR: join(root, "claude"),
        HERDR_SOCKET_PATH: join(root, "herdr.sock"),
        ...options.env,
      },
      stdin: {
        isTerminal: () => false,
        text: () => Promise.resolve(prompt),
      },
      cwd,
      signal: options.signal ?? new AbortController().signal,
      now: options.now,
      sleep: options.sleep,
    },
  };
}

function codexPath(root: string, id = codexId) {
  return join(
    root,
    "codex",
    "sessions",
    "2026",
    "09",
    "16",
    `rollout-anon-${id}.jsonl`,
  );
}

function claudePath(root: string, id = claudeId) {
  return join(root, "claude", "projects", "-workspace", `${id}.jsonl`);
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function codexMeta(id = codexId, sessionCwd = cwd) {
  return { type: "session_meta", payload: { id, cwd: sessionCwd } };
}

function codexTurn(
  id: string,
  prompt: string,
  result?: string,
  end: "complete" | "aborted" | "open" = result == null ? "open" : "complete",
  userMessages: {
    before?: string[];
    after?: string[];
    metadataPrompt?: boolean;
  } = {},
) {
  const userMessage = (text: string, metadata = false) => ({
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
      ...(metadata
        ? {
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["user.text"],
          },
        }
        : {}),
    },
  });
  return [
    { type: "event_msg", payload: { type: "task_started", turn_id: id } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "bootstrap은 무시" }],
      },
    },
    { type: "turn_context", payload: { turn_id: id, cwd } },
    ...(userMessages.before ?? []).map((text) => userMessage(text)),
    userMessage(prompt, userMessages.metadataPrompt),
    ...(userMessages.after ?? []).map((text) => userMessage(text)),
    ...(result == null ? [] : [{
      type: "response_item",
      payload: { type: "function_call", name: "tool", arguments: "secret" },
    }, {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: result }],
      },
    }]),
    ...(end === "complete"
      ? [{
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: id,
        },
      }]
      : end === "aborted"
      ? [{
        type: "event_msg",
        payload: { type: "turn_aborted", turn_id: id },
      }]
      : []),
  ];
}

function directReply(agent: "codex" | "claude"): FakeResponse {
  return {
    cmd: agent,
    stdout: agent === "codex"
      ? line({ type: "thread.started", thread_id: codexId }) + line({
        type: "item.completed",
        item: { type: "agent_message", text: "완료" },
      })
      : line({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: claudeId,
        result: "완료",
      }),
  };
}

function passedModel(args: readonly string[]): string | undefined {
  const index = args.indexOf("-m");
  return index >= 0
    ? args[index + 1]
    : args.find((arg) => arg.startsWith("--model="))?.slice("--model=".length);
}

function writeJsonl(path: string, records: readonly unknown[], partial = "") {
  Deno.mkdirSync(join(path, ".."), { recursive: true });
  Deno.writeTextFileSync(path, records.map(line).join("") + partial);
}

function appendJsonl(path: string, records: readonly unknown[]) {
  Deno.writeTextFileSync(path, records.map(line).join(""), { append: true });
}

function claudeOpen(prompt: string, id = claudeId, sessionCwd = cwd) {
  return [{
    type: "user",
    sessionId: id,
    cwd: sessionCwd,
    uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    origin: { kind: "human" },
    promptSource: "typed",
    userType: "external",
    isSidechain: false,
    message: { role: "user", content: prompt },
  }];
}

function herdr(
  result: unknown,
  extra: Partial<FakeResponse> = {},
): FakeResponse {
  return { cmd: "herdr", stdout: JSON.stringify({ result }), ...extra };
}

function herdrFailure(message: string): FakeResponse {
  return herdrError("herdr_failed", message);
}

function herdrError(code: string, message: string): FakeResponse {
  return {
    cmd: "herdr",
    code: 1,
    stderr: JSON.stringify({ error: { code, message } }),
  };
}

function newTabAllocation(): FakeResponse[] {
  return [
    herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
    herdr({ tabs: [] }),
    herdr({
      tab: { tab_id: "tab-delegate" },
      root_pane: { pane_id: "pane-delegate" },
    }),
  ];
}

function splitPaneAllocation(): FakeResponse[] {
  return [
    herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
    herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller" }] }),
    herdr({
      panes: [{
        pane_id: "pane-anchor",
        tab_id: "tab-delegate",
        agent: "busy",
        agent_status: "working",
      }],
    }),
    herdr({ pane: { pane_id: "pane-delegate" } }),
  ];
}

function completedUntilPostProcessing(
  path: string,
  prompt: string,
): FakeResponse[] {
  return [
    ...newTabAllocation(),
    herdr({ agent: currentAgent("working", 1) }),
    herdr({ agent: currentAgent("working", 1) }, {
      onStart: () =>
        writeJsonl(path, [
          codexMeta(),
          ...codexTurn("turn", prompt, "완료"),
        ]),
    }),
    herdr({}),
    herdr({ agent: liveAgent("done", 2) }),
    herdr({ agent: liveAgent("done", 2) }),
  ];
}

function successfulCleanup(): FakeResponse[] {
  return [herdr({})];
}

function liveAgent(
  status: string,
  sequence: number,
  id = codexId,
  sessionCwd = cwd,
) {
  return {
    name: `dlg-${id.replaceAll("-", "").slice(0, 28)}`,
    agent_kind: "codex",
    cwd: sessionCwd,
    agent_status: status,
    state_change_seq: sequence,
    agent_session: { kind: "id", value: id },
    workspace_id: "ws-1",
    tab_id: "tab-delegate",
    pane_id: "pane-delegate",
  };
}

function currentAgent(
  status: string,
  sequence: number,
  id = codexId,
  sessionCwd = cwd,
) {
  return {
    agent_kind: "codex",
    cwd: sessionCwd,
    agent_status: status,
    state_change_seq: sequence,
    agent_session: { kind: "id", value: id },
  };
}

function unidentifiedAgent(status: string, sequence: number) {
  return {
    agent_kind: "codex",
    cwd,
    agent_status: status,
    state_change_seq: sequence,
  };
}

function claudeLive(status: string, sequence: number, id = claudeId) {
  return {
    name: `dlg-${id.replaceAll("-", "").slice(0, 28)}`,
    agent: "claude",
    cwd,
    agent_status: status,
    state_change_seq: sequence,
    agent_session: { kind: "id", value: id },
    workspace_id: "ws-1",
    tab_id: "tab-delegate",
    pane_id: "pane-delegate",
  };
}

function currentClaude(status: string, sequence: number) {
  return {
    agent: "claude",
    cwd,
    agent_status: status,
    state_change_seq: sequence,
    agent_session: { kind: "id", value: claudeId },
  };
}

function unidentifiedClaude(status: string, sequence: number) {
  return {
    agent: "claude",
    cwd,
    agent_status: status,
    state_change_seq: sequence,
  };
}

function completedHerdrResponses(
  path: string,
  prompt: string,
  options: {
    onAgentStart?: () => void | Promise<void>;
    onCleanupStart?: () => void | Promise<void>;
  } = {},
): FakeResponse[] {
  return [
    herdr({ pane: { workspace_id: "ws-1", tab_id: "tab-current" } }),
    herdr({ tabs: [] }),
    herdr({
      tab: { tab_id: "tab-delegate" },
      root_pane: { pane_id: "pane-delegate" },
    }),
    herdr({ agent: currentAgent("working", 1) }, {
      onStart: options.onAgentStart,
    }),
    herdr({ agent: currentAgent("working", 1) }, {
      onStart: () =>
        writeJsonl(path, [
          codexMeta(),
          ...codexTurn("turn", prompt, "완료"),
        ]),
    }),
    herdr({}),
    herdr({ agent: liveAgent("done", 2) }),
    herdr({ agent: liveAgent("done", 2) }),
    herdr({}, { onStart: options.onCleanupStart }),
  ];
}
