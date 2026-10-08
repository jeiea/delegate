---
name: delegate
description: 코드 탐색 외 작업의 코덱스·클로드 세션 위임, 기존 위임의 후속 요청·확인·정리, 독립 관점·다른 모델 검토 시 사용
allowed-tools: Bash(herdr *) Bash(deno run *)
---

# 세션 선택

- `--agent`: 호출자 기준 `other`·`same`, 특정 `claude`·`codex`, 생략 시 `auto`
- `--model`: 반복 지정 시 선택된 agent에 유효한 첫 모델 사용
  - 클로드: `claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5`
  - 코덱스: `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-luna`
- 이전 호출과 관련 있으면 `<SESSION_ID>`로 후속 요청
- 두 에이전트 모두 호출 불가 시 서브에이전트 허용

# 위임 내용

- 역할·배경·확인한 사실·작업·종료 조건 전달
  - 선행 조사는 위임, 호출자만 접근 가능한 정보·실행 결과 포함
  - 작업 디렉터리의 `AGENTS.md`·`CLAUDE.md`는 자동 공유
- 종속 세션의 재위임 금지 명시
- 읽기 전용 필요 시 `--permission read-only`
- 프롬프트는 heredoc 표준 입력 또는 `--prompt-file`로 전달
  - 실제 개행 사용, 실행 후 표준 입력 전달 금지

# 실행

- Herdr 환경에서는 연결 문제 진단·복구 우선
- `direct` 필요 시 사용 전 유저에게 필요 사유·Herdr 진단 결과 보고
- 옵션·출력 필드·오류·경고 대응은 `--help` 확인
  - herdr 예외는 `herdr --skill` 확인
- 호스트 도구가 백그라운드 실행 ID를 반환하면 그 실행을 기다려 최종 출력·종료
  상태 확인
- `herdr agent` 직접 조립·원본 기록 조회는 스크립트 결함 조사에 한정

```sh
deno run -A {SKILL_BASE_DIR}/src/delegate.ts prompt --help

# 새 작업
deno run -A {SKILL_BASE_DIR}/src/delegate.ts prompt --agent other <<'PROMPT'
<역할, 맥락, 작업, 종료 조건>
PROMPT

# 실행 중·종료 후 후속 요청
deno run -A {SKILL_BASE_DIR}/src/delegate.ts prompt <SESSION_ID> <<'PROMPT'
<변경점, 후속 작업, 종료 조건>
PROMPT

# 진단·연결 유실 뒤 회수·중단
deno run -A {SKILL_BASE_DIR}/src/delegate.ts <status|wait|logs|close> <SESSION_ID>
```
