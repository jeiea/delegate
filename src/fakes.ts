import type { Exec, ExecResult } from "./process.ts";
import { TextLineStream } from "jsr:@std/streams@1.0.17/text-line-stream";

export type FakeCall = {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
};

export type FakeResponse = Partial<ExecResult> & {
  cmd: string;
  waitForAbort?: boolean;
  onStart?: () => void | Promise<void>;
  stdoutChunks?: string[];
  afterOutput?: () => void | Promise<void>;
};

export function fakeExec(responses: readonly FakeResponse[]): {
  exec: Exec;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  let index = 0;
  const exec: Exec = async (cmd, args, options) => {
    calls.push({
      cmd,
      args: [...args],
      cwd: options.cwd,
      env: { ...options.env },
      stdin: options.stdin,
    });
    const response = responses[index++];
    if (response == null) throw new Error(`예상하지 않은 실행: ${cmd}`);
    if (response.cmd !== cmd) {
      throw new Error(`예상한 실행 ${response.cmd}, 실제 ${cmd}`);
    }
    await response.onStart?.();
    for (const chunk of response.stdoutChunks ?? [response.stdout ?? ""]) {
      await options.onStdout?.(chunk);
    }
    await response.afterOutput?.();
    if (response.waitForAbort) {
      if (!options.signal?.aborted) {
        await new Promise<void>((resolve) =>
          options.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          })
        );
      }
      return {
        code: null,
        stdout: response.stdoutChunks?.join("") ?? response.stdout ?? "",
        stderr: response.stderr ?? "",
      };
    }
    return {
      code: response.code ?? 0,
      stdout: response.stdoutChunks?.join("") ?? response.stdout ?? "",
      stderr: response.stderr ?? "",
    };
  };
  return { exec, calls };
}

export type FakeSocketRequest = {
  id: string;
  method: string;
  params: Record<string, unknown>;
};

export type FakeSocketReply = {
  error?: { code: string; message: string };
  hang?: boolean;
  onRequest?: () => void;
};

export function fakeHerdrSocket(
  path: string,
  replies: readonly FakeSocketReply[] = [],
): {
  requests: FakeSocketRequest[];
  [Symbol.asyncDispose](): Promise<void>;
} {
  const listener = Deno.listen({ transport: "unix", path });
  const requests: FakeSocketRequest[] = [];
  const served: Promise<void>[] = [];
  const serve = async (conn: Deno.Conn) => {
    const lines = conn.readable.pipeThrough(new TextDecoderStream())
      .pipeThrough(new TextLineStream()).getReader();
    try {
      const request = JSON.parse(
        (await lines.read()).value!,
      ) as FakeSocketRequest;
      const reply = replies[requests.length] ?? {};
      requests.push(request);
      reply.onRequest?.();
      // 무응답은 클라이언트가 연결을 닫아야 끝난다.
      if (reply.hang) {
        await lines.read();
        return;
      }
      const body = reply.error == null
        ? { id: request.id, result: {} }
        : { id: request.id, error: reply.error };
      await conn.write(
        new TextEncoder().encode(`${JSON.stringify(body)}\n`),
      );
    } finally {
      await lines.cancel();
    }
  };
  const accepting = (async () => {
    for await (const conn of listener) served.push(serve(conn));
  })();
  return {
    requests,
    async [Symbol.asyncDispose]() {
      listener.close();
      await accepting.catch(() => {});
      await Promise.allSettled(served);
    },
  };
}
