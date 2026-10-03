import { DELIMITER, resolve } from "jsr:@std/path@1.1.6";

export type ExecResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

export type Exec = (
  cmd: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    stdin?: string;
    signal?: AbortSignal;
    onStdout?: (chunk: string) => void | Promise<void>;
  },
) => Promise<ExecResult>;

export async function hasExecutable(
  command: string,
  options: { cwd: string; env: Record<string, string>; shell?: boolean },
): Promise<boolean> {
  const windows = Deno.build.os === "windows";
  const env = windows
    ? Object.fromEntries(
      Object.entries(options.env).map((
        [key, value],
      ) => [key.toUpperCase(), value]),
    )
    : options.env;
  const path = env.PATH;
  if (path == null) return false;
  // Deno.Command는 Windows에서 확장자 없는 명령에 .exe를 붙여 찾는다.
  // Herdr는 셸을 통해 실행하므로 PowerShell 스크립트와 PATHEXT도 인식한다.
  const extensions = windows
    ? options.shell
      ? [".ps1", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")]
      : [".exe"]
    : [""];
  for (const directory of path.split(DELIMITER)) {
    for (const extension of extensions) {
      try {
        const stat = await Deno.stat(resolve(
          options.cwd,
          windows ? directory.replaceAll('"', "") : directory,
          `${command}${extension}`,
        ));
        if (stat.isFile && (windows || ((stat.mode ?? 0) & 0o111) !== 0)) {
          return true;
        }
      } catch (error) {
        if (
          !(error instanceof Deno.errors.NotFound ||
            error instanceof Deno.errors.NotADirectory)
        ) {
          throw error;
        }
      }
    }
  }
  return false;
}

export const denoExec: Exec = async (cmd, args, options) => {
  const child = new Deno.Command(cmd, {
    args,
    cwd: options.cwd,
    env: options.env,
    clearEnv: true,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    signal: options.signal,
  }).spawn();
  const stdout = (async () => {
    let output = "";
    for await (
      const chunk of child.stdout.pipeThrough(new TextDecoderStream())
    ) {
      output += chunk;
      await options.onStdout?.(chunk);
    }
    return output;
  })();
  const stderr = new Response(child.stderr).text();
  const writer = child.stdin.getWriter();
  let stdinError: unknown;
  try {
    await writer.write(new TextEncoder().encode(options.stdin ?? ""));
    await writer.close();
  } catch (error) {
    stdinError = error;
  }

  let code: number | null = null;
  try {
    code = (await child.status).code;
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      throw error;
    }
  }
  const result = { code, stdout: await stdout, stderr: await stderr };
  if (stdinError != null && !(stdinError instanceof Deno.errors.BrokenPipe)) {
    throw stdinError;
  }
  return result;
};
