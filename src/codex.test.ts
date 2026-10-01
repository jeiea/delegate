import { assertEquals } from "jsr:@std/assert@1.0.19";
import { planCodex } from "./codex.ts";
import type { PlanRequest } from "./select.ts";

const sessionId = "019efcf8-381f-74a2-a141-f105f1e00e81";
const setting = ["-c", "check_for_update_on_startup=false"] as const;

Deno.test("Codex 인자는 권한과 재개 여부에 관계없이 시작 전 업데이트 확인을 끈다", () => {
  for (
    const request of [
      { permission: "read-only" },
      { permission: "read-only", resumeSessionId: sessionId },
      { permission: "write" },
      { permission: "write", resumeSessionId: sessionId },
    ] as const
  ) {
    const plan = planCodex(
      {
        cwd: "/workspace",
        addDirs: [],
        prompt: "작업",
        ...request,
      } satisfies PlanRequest,
    );

    for (const args of [plan.directArgs, plan.herdrArgs]) {
      const settingIndex = args.findIndex((value, index) =>
        value === setting[0] && args[index + 1] === setting[1]
      );
      assertEquals(countPair(args, setting), 1, JSON.stringify(request));
      const subcommand = args === plan.directArgs
        ? "exec"
        : request.resumeSessionId == null
        ? undefined
        : "resume";
      if (subcommand != null) {
        assertEquals(
          settingIndex < args.indexOf(subcommand),
          true,
          JSON.stringify(request),
        );
      }
    }
  }
});

function countPair(args: readonly string[], pair: readonly string[]): number {
  return args.reduce(
    (count, value, index) =>
      count + Number(value === pair[0] && args[index + 1] === pair[1]),
    0,
  );
}

Deno.test("읽기 전용 Codex는 파일 쓰기만 막고 네트워크 조회는 승인 없이 허용한다", () => {
  const plan = planCodex({
    cwd: "/workspace",
    addDirs: [],
    prompt: "조사",
    permission: "read-only",
  });

  for (const args of [plan.directArgs, plan.herdrArgs]) {
    assertEquals(args.includes("-s"), false);
    for (
      const value of [
        'default_permissions="delegate-read-only"',
        'permissions.delegate-read-only.extends=":read-only"',
        "permissions.delegate-read-only.network.enabled=true",
      ]
    ) {
      assertEquals(countPair(args, ["-c", value]), 1, value);
    }
  }
});
