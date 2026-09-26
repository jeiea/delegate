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

## agent-files의 스킬 갱신

변경을 커밋한 뒤 해당 커밋의 전체 해시를 URL에 넣어 스킬을 생성한다.

```sh
deno run -A https://raw.githubusercontent.com/jeiea/delegate/<commit>/src/delegate.ts --skill \
  > <agent-files>/source/skills/delegate/SKILL.md
```

생성된 스킬의 모든 실행 명령은 같은 커밋을 가리킨다. 다음 변경은 새 커밋 주소로
다시 생성해 반영한다. 디노가 이전 주소에 캐시한 코드는 새 주소의 실행에 영향을
주지 않는다.
