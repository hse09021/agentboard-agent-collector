# AgentBoard — AI Agent Usage Collector

AI 코딩 도구(Claude Code, Codex)의 토큰 사용량을 자동으로 수집하여 [AgentBoard](https://agentboard.kro.kr)로 전송하는 경량 CLI 도구입니다.

## 특징

- **프라이버시 우선** — 프롬프트, 코드, 파일 경로, 저장소 정보는 절대 수집하지 않습니다. 토큰 카운트, 타임스탬프, 모델명과 요금제 잔여율만 전송됩니다.
- **비동기 전송** — 훅 스크립트가 즉시 종료된 후 백그라운드 워커가 업로드를 처리하여 AI 도구의 응답속도에 영향을 주지 않습니다.
- **턴 단위 수집** — 세션이 끝날 때만이 아니라 매 턴마다 델타를 올려, 대화 중에도 대시보드에 사용량이 반영됩니다.
- **요금제 스냅샷** — 과금되는 턴을 쓰지 않고 각 CLI의 로컬 상태 조회로 요금제명과 남은 rate-limit %를 수집합니다.
- **지원 도구** — Claude Code, Codex CLI 동시 지원

## 요구 사항

- Node.js >= 20

## 설치

아직 npm 레지스트리에 배포되지 않았으므로 저장소를 클론해 설치합니다.

```bash
git clone https://github.com/hse09021/agentboard-agent-collector.git
cd agentboard-agent-collector
npm install
npm run build
npm link
```

## 업데이트

이미 설치된 collector를 최신 버전으로 올릴 때는 아래 명령을 사용합니다.

```bash
cd agentboard-agent-collector
git pull
npm install
npm run build
npm uninstall -g @agentboard/collector
npm link
agentboard --version
agentboard install-hooks --force
agentboard doctor
```

업데이트해도 로그인 토큰과 기기 ID는 보통 유지됩니다. 로컬 설정은 패키지 내부가 아니라 `~/.agentboard`에 저장됩니다.
다만 훅 스크립트 경로나 내용이 바뀔 수 있으므로 업데이트 후에는 `agentboard install-hooks --force`를 실행하는 것을 권장합니다.

Windows에서 `npm link` 실행 중 `EEXIST: file already exists ... agentboard.cmd` 오류가 발생하면 기존 전역 링크가 남아 있는 상태입니다.
아래처럼 기존 전역 설치/링크를 제거한 뒤 다시 link 하세요.

```bash
npm uninstall -g @agentboard/collector
npm link
```

그래도 같은 오류가 계속되면 PowerShell에서 오래된 shim 파일을 직접 제거한 뒤 다시 link 합니다.

```powershell
Remove-Item "$env:APPDATA\npm\agentboard.cmd" -ErrorAction SilentlyContinue
Remove-Item "$env:APPDATA\npm\agentboard.ps1" -ErrorAction SilentlyContinue
Remove-Item "$env:APPDATA\npm\agentboard" -ErrorAction SilentlyContinue
npm link
```

## 사용법

### 1. 로그인

```bash
agentboard login
```

터미널에 출력된 URL을 브라우저로 열고, GitHub OAuth 완료 후 표시되는 인증 토큰을 터미널에 붙여넣으면 됩니다.

### 2. 훅 등록

```bash
agentboard install-hooks
```

지원하는 AI 도구(Claude Code, Codex CLI)에 세션 훅을 자동으로 등록합니다. 설치된 것이 확인되지 않은 도구는 건너뜁니다.

- **Claude Code** — `~/.claude/settings.json`의 `Stop`(매 턴) + `SessionEnd`(세션 종료)
- **Codex CLI** — `~/.codex/config.toml`의 `notify`(매 턴) + `~/.codex/hooks.json`의 `SessionEnd`·`SubagentStop`

덕분에 대화가 진행되는 동안에도 사용량이 대시보드에 반영됩니다.
Codex의 `hooks.json` 훅은 Codex 안에서 `/hooks`를 실행해 신뢰 승인을 해야 발동합니다(승인 전까지는 `notify`만 동작).
이미 등록된 훅을 강제로 재등록하려면:

```bash
agentboard install-hooks --force
```

### 3. 상태 확인

```bash
agentboard status
```

인증 상태, 기기 ID, 훅 등록 여부, 주간/월간 사용량 통계를 표시합니다.

### 4. 진단

```bash
agentboard doctor
```

설정 디렉터리 접근성, API 연결 상태, 훅 등록 유효성 등 전체 환경을 점검합니다.

### 5. 훅 해제

```bash
agentboard uninstall-hooks
```

등록된 모든 훅을 제거합니다.

### 6. 로그아웃

```bash
agentboard logout
```

저장된 인증 토큰을 안전하게 삭제합니다.

## 훅 아키텍처

```
Claude Code 턴 종료(Stop) / 세션 종료(SessionEnd)
      │
      ▼
plugin/hooks/claude/session-end.mjs   (stdin → 임시파일 저장, 즉시 종료)
      │
      ▼  (detached 프로세스)
plugin/hooks/claude/worker.mjs        (Claude 수집 → 세션 락 → 파싱 → 델타 계산 → 업로드)
      └── plugin/hooks/claude/parse-claude.mjs

Codex 턴 종료(notify)          → plugin/hooks/codex/notify.mjs         (매 턴: 부모 세션 파싱 → 델타 → 업로드)
Codex 세션 종료(SessionEnd)    → plugin/hooks/codex/session-end.mjs    (rate-limit 강제 캡처 + 부모 잔여 스윕)
Codex 서브에이전트 종료(SubagentStop) → plugin/hooks/codex/subagent-stop.mjs (자식 rollout 파싱 → 부모 세션에 합산)
      └── plugin/hooks/codex/parse-codex.mjs

  ※ Codex SessionEnd/SubagentStop은 ~/.codex/hooks.json에 등록되며 `/hooks`로 신뢰 승인이 필요합니다.
     구버전 Codex는 이 파일을 무시하고 notify만 사용합니다.

공통 모듈은 plugin/hooks/lib/ (config, transport, forbidden-data-guard, usage-limit*)
```

업로드는 델타 방식입니다: 세션별로 이미 전송한 누적 토큰을 기록해 두고, 훅이 발동할 때마다
그 이후 늘어난 만큼만 전송합니다. 같은 세션의 훅이 겹쳐 실행되는 경우(매 턴 발동)에는
세션 단위 락이 중복 업로드를 막습니다. Codex의 경우 매 턴마다 `codex/notify.mjs`가 호출되어
동일한 델타·락 방식으로 세션 중에도 점진적으로 데이터를 수집합니다.

## 설정

설정 파일 위치:
- Linux/macOS: `~/.agentboard/config.json`
- Windows: `%APPDATA%\agentboard\config.json`

### 환경 변수

| 변수 | 설명 | 기본값 |
|------|------|--------|
| `AGENTBOARD_API_URL` | core-api 프록시 엔드포인트 URL | `https://agentboard.kro.kr/api/proxy` |
| `AGENTBOARD_APP_URL` | OAuth 로그인용 AgentBoard 웹 앱 URL | API URL의 origin에서 유도 |
| `AGENTBOARD_ENABLE_USAGE_LIMIT_CAPTURE` | `0`으로 설정 시 요금제 스냅샷 수집을 끔 | 활성 |

훅은 진단용으로 `<설정 디렉터리>/hook-debug.log`에 디버그 로그를 항상 남깁니다(detached 워커는 stdout/stderr가 버려지기 때문).

## 개인정보 보호 모델

수집하는 데이터:
- 토큰 수 (input, output, cache creation, cache read)
- 세션 시작/종료 시간
- AI 모델명
- 운영체제 종류 (기기 등록 시 1회)
- 익명화된 기기 ID
- 요금제 스냅샷: 요금제 이름과 5시간·주간 잔여 rate-limit %, 그리고 그 판독의 원본 CLI 출력
  (업로드 직전 경로 패턴이 감지되면 원본 출력은 마스킹됨)

**절대 수집하지 않는 데이터:**
- 프롬프트 내용
- 코드 내용
- 파일 경로
- 저장소 이름
- 커밋 내용
- PR/이슈 내용
- 터미널 명령

## 개발

```bash
# 의존성 설치
npm install

# 빌드
npm run build

# 테스트
npm test

# 커버리지
npm run test:coverage

# 개발 모드 (watch)
npm run dev
```

## 라이선스

MIT

