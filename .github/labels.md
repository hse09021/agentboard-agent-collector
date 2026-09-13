# 라벨

이슈 템플릿과 브랜치 자동 생성 워크플로가 아래 라벨에 의존합니다.
`gh`로 한 번만 만들어 두면 됩니다.

```bash
gh label create ready         --color 0E8A16 --description "작업 시작 — 브랜치가 생성됩니다"      --force
gh label create bug           --color D73A4A --description "동작이 깨짐"                          --force
gh label create enhancement   --color A2EEEF --description "새 기능 또는 개선"                    --force
gh label create refactor      --color FBCA04 --description "동작 변경 없는 구조 개선"             --force
gh label create chore         --color 0052CC --description "유지보수, 릴리스, 의존성"             --force
gh label create performance   --color 5319E7 --description "속도 또는 자원 사용"                  --force
gh label create documentation --color 0075CA --description "문서만 변경"                          --force
gh label create security      --color B60205 --description "보안 관련"                            --force
```

## 이슈 자동화

`.github/workflows/issue-automation.yml`이 두 가지를 처리합니다.

| 시점 | 동작 |
|---|---|
| 이슈가 열릴 때 | 작성자를 담당자로 자동 지정 (이미 담당자가 있으면 건너뜀) |
| `ready` 라벨이 붙을 때 | 작업 브랜치 생성 + 체크아웃 명령 댓글 |

## 브랜치 접두사가 정해지는 방식

이슈의 라벨을 읽어 커밋 컨벤션 접두사로 변환합니다.
위에서부터 먼저 일치하는 것이 적용됩니다.

| 이슈 라벨       | 브랜치 접두사 | 이슈 템플릿 |
|-----------------|---------------|-------------|
| `bug`           | `fix/`        | fix         |
| `security`      | `fix/`        | —           |
| `enhancement`   | `feat/`       | feat        |
| `feature`       | `feat/`       | —           |
| `refactor`      | `refactor/`   | refactor    |
| `performance`   | `perf/`       | —           |
| `documentation` | `docs/`       | —           |
| `chore`         | `chore/`      | chore       |
| `task`          | `chore/`      | — (구 라벨) |
| *(위에 없음)*   | `chore/`      | —           |

브랜치 이름은 `<타입>/<이슈번호>-<슬러그>` 형식입니다. 슬러그는 이슈 템플릿의
"브랜치 슬러그 (영문)" 입력란에서 가져오며, 비워 두면 이슈 번호만 붙습니다
(예: `fix/42`).

`ready`는 **실제로 작업을 시작할 때** 붙이세요. 이 라벨이 브랜치 생성을
트리거합니다.

## 대시보드 저장소와의 관계

이 저장소는 수집기 CLI 전용입니다. 웹 대시보드·API 서버 이슈는
[ai-cost-dashboard](https://github.com/hse09021/ai-cost-dashboard/issues)에 올립니다.
두 저장소는 같은 라벨 체계와 브랜치 규칙을 공유합니다.

이벤트 형식처럼 양쪽이 함께 바뀌어야 하는 변경은 각 저장소에 이슈를 하나씩
만들고 서로 링크해 두세요 — 배포 순서(서버 먼저, 수집기 나중)를 지켜야 합니다.
