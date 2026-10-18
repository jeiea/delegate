if (import.meta.main) {
  console.log(await requestPipe(Deno.args[0]!, Deno.args[1]!));
}

async function requestPipe(path: string, request: string): Promise<string> {
  // HERDR_SOCKET_PATH는 Windows에서 마커 파일이며 같은 이름의 파이프로 연결한다.
  using pipe = await Deno.open(`\\\\.\\pipe\\${path}`, {
    read: true,
    write: true,
  });
  const bytes = new TextEncoder().encode(`${request}\n`);
  let written = 0;
  while (written < bytes.length) {
    written += await pipe.write(bytes.subarray(written));
  }

  // 스트림의 미리 읽기가 응답 뒤에도 차단 읽기를 남기지 않게 한 줄까지만 읽는다.
  const decoder = new TextDecoder();
  const buffer = new Uint8Array(4096);
  let response = "";
  while (!response.includes("\n")) {
    const count = await pipe.read(buffer);
    if (count == null) break;
    response += decoder.decode(buffer.subarray(0, count), { stream: true });
  }
  return response.split("\n", 1)[0]!;
}
