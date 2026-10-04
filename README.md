# delegate

코덱스와 클로드의 네이티브 세션에 작업을 맡기고 결과를 회수하는 디노 CLI와 스킬.

## 실행

```sh
deno run -A src/delegate.ts --help
deno run -A src/delegate.ts --skill
deno task verify
```

`SKILL.md`는 저장소를 스킬 디렉터리로 사용할 때 실행 가능한 원본이다.
`--skill`은 이 파일의 CLI 경로를 현재 실행한 `delegate.ts` 주소로 바꿔 출력한다.
