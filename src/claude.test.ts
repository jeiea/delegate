import { assertEquals } from "jsr:@std/assert@1.0.19";
import { planClaude } from "./claude.ts";

Deno.test("읽기 전용 Claude는 auto 모드로 판단하고 남은 권한 요청은 유저에게 묻는다", () => {
  const plan = planClaude({
    cwd: "/workspace",
    addDirs: [],
    prompt: "조사",
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
