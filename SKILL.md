---
name: delegate
description: 코드 탐색 외 작업의 코덱스·클로드 세션 위임, 기존 위임의 후속 요청·확인·정리, 독립 관점·다른 모델 검토 시 사용
allowed-tools: Bash(herdr *) Bash(deno run *)
---

# 세션 선택

- `--agent`: 에이전트 종류 지정, 생략 가능
  - `other`: 다른 에이전트
  - `same`: 같은 에이전트
  - `claude`, `codex`: 특정
  - `auto`: 생략과 동일, 아무 가용한 것
- 두 에이전트 모두 호출 불가 시 서브에이전트 허용
- 모델 지정 시 `--model` 반복, 선택된 agent에 유효한 첫 모델 사용
- 이전 호출과 관련 있으면 후속 요청 고려

# 위임 내용

- 역할·배경·확인한 사실·작업·종료 조건 전달
  - 선행 조사는 위임, 호출자만 접근 가능한 정보·실행 결과 포함
- 종속 세션의 재위임 금지 명시
- 작업 디렉터리의 `AGENTS.md`·`CLAUDE.md` 맥락 기본 공유
- 기본 쓰기 허용, 읽기 전용 필요 시 `--permission read-only`
- 프롬프트는 실행 시 heredoc 표준 입력 또는 `--prompt-file`로 전달
  - 실제 개행 사용, 실행 후 표준 입력 전달 금지
- 클로드 호출자는 스크래치패드 UUID를 `--caller-id`로 전달

# 실행·정리

- 일반 위임은 아래 스크립트 사용
  - `herdr agent start/prompt/read` 직접 조립·프로세스·원본 기록 조회는 스크립트
    진단 결함 조사에 한정
- 호스트 도구가 실행 세션을 반환하면 해당 세션으로 대기해 최종 출력·종료 상태
  확인
- 옵션·출력·오류 대응은 하위 명령 `--help` 확인
  - 터미널 멀티플렉서 herdr의 예외 정보는 `herdr --skill` 확인
- 식별자는 코덱스·클로드 네이티브 세션 ID
- 차단 오류는 확인된 `error.pane.pane_id`와 마크다운 본문의 현재 화면을 확인해
  대응. 시작 차단은 요청이 제출되지 않은 상태
- 클로드의 `session_id`는 시작 전에 발급된 UUID일 수 있어 네이티브 기록 파일의
  존재를 뜻하지 않음. 차단 해소 뒤에도 파일이 없으면 보존 pane을 확인하고 필요
  시 명시적으로 정리
- Herdr의 `prompt`·`wait` 성공 시 옮긴 터미널 분할 창도 자동 정리
  - 같은 ID로 대화 재개 가능
  - `close`는 Herdr 창의 중단·자동 정리 실패 시 사용

```sh
deno run -A {SKILL_BASE_DIR}/src/delegate.ts prompt --help

# 새 동기 작업
deno run -A {SKILL_BASE_DIR}/src/delegate.ts prompt \
  --agent other <<'PROMPT'
<역할, 맥락, 작업, 종료 조건>
PROMPT

# 실행 중·종료 후 후속 요청
deno run -A {SKILL_BASE_DIR}/src/delegate.ts prompt <SESSION_ID> <<'PROMPT'
<변경점, 후속 작업, 종료 조건>
PROMPT

deno run -A {SKILL_BASE_DIR}/src/delegate.ts status <SESSION_ID>
deno run -A {SKILL_BASE_DIR}/src/delegate.ts wait <SESSION_ID> --timeout 20m
deno run -A {SKILL_BASE_DIR}/src/delegate.ts logs <SESSION_ID> --lines 200
deno run -A {SKILL_BASE_DIR}/src/delegate.ts close <SESSION_ID>
```
