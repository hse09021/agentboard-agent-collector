# AgentBoard — AI Agent Usage Collector

AI 코딩 도구(Claude Code, Codex, OpenCode, GitHub Copilot, Gemini CLI)의 토큰 사용량을 자동으로 수집하여 [AgentBoard](https://agentboard.kro.kr)로 전송하는 경량 CLI 도구입니다.

## 특징

- **프라이버시 우선** — 프롬프트, 코드, 파일 경로, 저장소 정보는 절대 수집하지 않습니다. 오직 토큰 카운트와 타임스탬프만 전송됩니다.
- **비동기 전송** — 훅 스크립트가 즉시 종료된 후 백그라운드 워커가 업로드를 처리하여 AI 도구의 응답속도에 영향을 주지 않습니다.
- **다중 도구 지원** — Claude Code, Codex CLI, OpenCode, GitHub Copilot, Gemini CLI 동시 지원

## 요구 사항

- Node.js >= 20

## 설치

```bash
npm install -g @agentboard/collector
```

또는 저장소를 직접 클론하여 설치:

```bash
git clone https://github.com/hse09021/agentboard-agent-collector.git
cd agentboard-agent-collector
npm install
npm run build
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

지원하는 AI 도구(Claude Code, Gemini CLI, Codex CLI)에 세션 종료 훅을 자동으로 등록합니다.  
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
AI 도구 세션 종료
      │
      ▼
plugin/hooks/session-end.mjs   (stdin → 임시파일 저장, 즉시 종료)
      │
      ▼  (detached 프로세스)
plugin/hooks/worker.mjs        (소스 감지 → 세션 파싱 → 중복 제거 → 업로드)
      │
      ├── lib/parse-claude.mjs
      ├── lib/parse-codex.mjs
      ├── lib/parse-gemini.mjs
      └── lib/parse-opencode.mjs
```

Codex의 경우 매 턴마다 `codex-notify.mjs`가 호출되어 세션 중에도 점진적으로 데이터를 수집합니다.

## 설정

설정 파일 위치:
- Linux/macOS: `~/.agentboard/config.json`
- Windows: `%APPDATA%\agentboard\config.json`

### 환경 변수

| 변수 | 설명 | 기본값 |
|------|------|--------|
| `AGENTBOARD_API_URL` | core-api 프록시 엔드포인트 URL | `https://agentboard.kro.kr/api/proxy` |
| `AGENTBOARD_APP_URL` | OAuth 로그인용 AgentBoard 웹 앱 URL | `https://agentboard.kro.kr` |
| `AGENTBOARD_DEBUG` | `1`로 설정 시 디버그 로그 출력 | 비활성 |

## 개인정보 보호 모델

수집하는 데이터:
- 토큰 수 (input, output, cache creation, cache read)
- 세션 시작/종료 시간
- AI 모델명
- 운영체제 종류
- 익명화된 기기 ID

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
