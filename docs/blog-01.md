# [Local DevLog MCP #1] Git Push만으로 개발 일지를 자동화할 수 있을까? — 문제 정의와 아키텍처 설계

> 이 글은 구현 완료기가 아닌 **설계 및 개발 착수 기록**이다. 앞으로 2주 동안 MVP를 구현하고, 실제로 부딪힌 문제와 해결 과정을 연재할 예정이다.

## 1. 왜 만들려고 했을까?

여러 개인 개발 프로젝트를 병행하다 보면 코드는 GitHub에 남지만, 그날 무엇을 해결했고 다음에 무엇을 해야 하는지는 흩어지기 쉽다. Commit 메시지와 Diff를 다시 읽으면 어느 정도 복원할 수 있지만, 그것을 Notion의 작업 카드나 일정 기록으로 옮기는 과정은 수작업이다.

원하는 흐름은 단순하다. 평소처럼 코드를 작성하고 Push한다. 하루가 끝나면 AI에게 '오늘 작업 정리해줘'라고 말한다. AI는 여러 Repository의 변경 내역을 읽어 초안을 작성한다. 내가 내용을 검토하고 승인하면 Notion과 macOS 기본 Calendar에 기록된다.

중요한 것은 **자동 수집과 자동 발행을 구분하는 것**이다. Git의 변경 이력은 객관적인 근거지만, 그 코드가 왜 작성됐고 작업이 완료됐는지는 AI도 확신할 수 없다. 따라서 최종 기록은 사람이 승인한다.

## 2. 왜 Git Push를 기준으로 잡았을까?

Commit은 로컬에 남을 수 있고, 작업 중간에 여러 번 생성된다. Push는 개발자가 변경 사항을 원격에 공유하려는 비교적 명확한 시점이다. 여러 Repository를 관리할 때에도 일관된 이벤트로 사용하기 좋다.

하지만 여기에는 함정이 있다. Git의 `pre-push` Hook은 이름 그대로 **Push 이전**에 실행된다. Hook에서 이벤트를 기록했다고 해서 원격 Push가 성공했다는 뜻은 아니다. 네트워크 오류, 권한 문제, 원격 거부로 Push가 실패할 수 있다.

그래서 MVP에서는 Hook을 'Push 성공 이벤트'가 아니라 **Push 시도 신호**로 다룬다. Hook은 Repository와 Ref 정보를 로컬에 빠르게 기록하고 종료한다. AI가 일지를 요청하는 시점에 Git의 실제 원격 상태를 조회해 검증할 수 있는 변경만 확정적으로 표현한다. 검증할 수 없으면 미확인 상태로 남긴다.

이 선택에는 트레이드오프가 있다. `devlog push` 같은 전용 래퍼를 사용하면 Push 프로세스의 종료 코드를 확인하기 쉽지만, 모든 사용자가 기존 Git 사용 습관을 바꿔야 한다. 반대로 `pre-push`는 평소의 `git push`를 그대로 쓸 수 있으나 성공 판정은 별도로 해야 한다. 공개용 MVP에서는 사용성에 우선순위를 뒀다.

## 3. MCP 서버는 항상 실행돼 있어야 할까?

아니다. 이 설계에서는 Git Hook과 MCP 서버가 서로 다른 시점에 동작한다.

```text
[개발 중]
git push
  -> pre-push Hook
  -> 로컬 JSON에 Push 시도 저장

[하루 정리 시]
Codex / Claude 등 AI 클라이언트
  -> Local DevLog MCP (stdio)
  -> 로컬 Git 이력 조회
  -> AI가 초안 작성
  -> 사용자 검토/승인
  -> Notion + Apple Calendar 기록
```

Git Hook은 Git이 필요할 때 실행하는 로컬 스크립트다. 별도의 상주 MCP 프로세스가 없어도 이벤트를 저장할 수 있다. MCP 서버는 클라이언트가 Tool을 호출할 때 실행되도록 `stdio` 방식으로 구성할 계획이다.

여기서 MCP는 AI 모델이 아니다. **Model Context Protocol**은 AI 클라이언트가 외부 기능과 데이터에 접근할 수 있게 해주는 인터페이스다. Git을 읽고 Notion에 기록하는 기능은 우리가 만들고, 자연어 요약과 다음 작업 제안은 Codex나 Claude 같은 MCP 클라이언트의 모델이 담당한다. 별도 LLM API 키를 서버에 내장할 필요가 없는 이유다.

## 4. Notion은 칸반인가, 캘린더인가?

둘 중 하나를 고르기보다 데이터를 역할별로 나누기로 했다.

| 저장 대상 | 기록 내용 | 목적 |
|---|---|---|
| Notion Tasks | 해야 할 일, 상태, 우선순위 | 앞으로의 작업 관리 |
| Notion Work Logs | 날짜, 프로젝트, 작업 요약, 근거 Commit | 실제 수행한 작업 기록 |
| Apple Calendar | 날짜별 개발 요약 | 시간순 활동 확인 |

Notion의 Tasks DB에는 칸반 View와 캘린더 View를 함께 둘 수 있다. 한 작업을 3일 동안 진행하며 여러 번 Push하더라도 Task 카드를 무한히 만들지 않고 Work Log에 날짜별 이력을 쌓는다.

Apple Calendar에는 Push마다 이벤트를 생성하지 않고, 하루에 하나의 개발 요약 이벤트를 만드는 방향이다. Push 시간만으로 실제 작업 시작·종료 시간을 추정할 수 없으므로 MVP에서는 종일 이벤트를 사용한다.

## 5. 아키텍처를 단순하게 유지하는 이유

처음에는 SQLite, 별도 Collector 프로세스, 여러 패키지로 구성된 Monorepo까지 고려했다. 하지만 목표는 거대한 업무 플랫폼이 아니라 **2주 안에 실제로 사용 가능한 MVP**다.

그래서 하나의 TypeScript 프로젝트로 시작한다.

```text
local-devlog-mcp/
  src/
    git/         # Hook과 Git 조회
    mcp/         # MCP Tool
    services/    # 일지 초안/승인/발행
    adapters/    # Notion, Calendar
    storage/     # 로컬 JSON
    cli/         # 초기 설정
  native/        # Swift EventKit 브리지
  tests/
  docs/
```

MCP Tool은 먼저 날짜별 Git 활동을 읽는 `get_daily_activity`부터 만들고, 이후 초안 저장·승인·발행 기능을 붙일 예정이다. 승인되지 않은 초안은 외부 시스템에 전송하지 않는다. Notion 저장만 성공하고 Calendar 저장은 실패하는 상황에서도 재시도 시 중복 생성되지 않도록 로컬 ID와 외부 ID를 연결해야 한다.

## 6. Slack과 KakaoTalk도 붙일 수 있을까?

가능성을 열어둘 계획이지만 이번 MVP에는 포함하지 않는다. Notion과 Calendar에 발행하는 코드를 각각 Adapter로 분리하면 향후 Slack 채널 알림 등을 추가할 때 Git 수집 로직을 다시 만들 필요가 없다.

다만 Slack 알림 전송과 KakaoTalk Bot의 명령 수신은 같은 문제가 아니다. 전자는 발행 기능에 가깝고 후자는 외부 이벤트를 받는 기능까지 필요하다. 실제 확장 시에는 공식 API 권한과 사용 제약을 확인하고 인터페이스를 별도로 설계할 예정이다. 미래를 위해 빈 플러그인 프레임워크를 미리 만들지는 않는다.

## 7. 2주 개발 계획

- **1~2일:** TypeScript 프로젝트, MCP 연결, 설정 구조
- **3~4일:** Git Hook 설치와 Push 시도 수집, 원격 검증
- **5~7일:** Git 활동 조회 Tool, AI 초안과 사용자 승인
- **8~9일:** Notion Tasks / Work Logs 연동
- **10~11일:** macOS EventKit Calendar 연동
- **12~14일:** 중복 방지, 설치 테스트, GitHub 공개 문서

최종 목표는 누구나 GitHub에서 Clone한 뒤 Repository 경로와 Notion 설정을 입력해 사용할 수 있는 도구다. 첫 번째 구현 단계에서는 실제로 AI 클라이언트가 MCP Tool을 호출하고 Git 활동을 읽어오는 것부터 확인하려고 한다.

## 8. 다음 편 예고

다음 글에서는 Codex와 함께 TypeScript 기반 MCP 서버를 초기화하고, `stdio` 통신으로 Tool을 노출하는 과정을 다룰 예정이다. MCP가 어떤 방식으로 클라이언트와 메시지를 주고받는지, 일반적인 REST API와 무엇이 다른지도 코드와 함께 살펴보려고 한다.

---

**태그:** `MCP`, `Model Context Protocol`, `TypeScript`, `Git Hook`, `Git`, `Codex`, `Notion API`, `macOS`, `바이브코딩`, `개발자동화`
