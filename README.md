# github-workflow-mcp

Claude Code에 자연어 지시 한 번으로 GitHub 워크플로우를 자동화하는 MCP 서버.  
브랜치 생성 → 코드 작성 → 테스트 → 커밋/Push → PR 오픈까지 한 번에 처리합니다.

---

## 목차

- [기술 스택](#기술-스택)
- [아키텍처](#아키텍처)
- [제공 도구](#제공-도구)
- [제공 리소스](#제공-리소스)
- [제공 프롬프트](#제공-프롬프트)
- [동작 로직](#동작-로직)
- [설치](#설치)
- [Claude Code 연결](#claude-code-연결)
- [환경 변수](#환경-변수)
- [사용 방법](#사용-방법)
- [테스트](#테스트)
- [보안](#보안)

---

## 기술 스택

| 분류 | 기술 | 버전 | 역할 |
|------|------|------|------|
| 런타임 | Node.js | ≥ 18 | ESM 모듈 시스템, native `fetch` |
| MCP | `@modelcontextprotocol/sdk` | ^1.17.5 | stdio 기반 MCP 서버 (`McpServer`, `StdioServerTransport`) |
| 스키마 검증 | `zod` | ^3.25.76 | 도구 입력 파라미터 런타임 타입 검증 |
| AI 코드 생성 | `@anthropic-ai/sdk` | ^0.104.1 | Claude Sonnet 4.6 호출 (`run_workflow` 전용) |
| GitHub API | REST API v3 | — | native `fetch` 직접 호출, 외부 라이브러리 없음 |
| Git 조작 | `git` CLI | — | `execFileSync` / `spawn` via `node:child_process` |
| 테스트 | `node:test` | built-in | 외부 프레임워크 없이 26개 단위 테스트 |

---

## 아키텍처

```
Claude Code (사용자)
      │ 자연어 지시
      ▼
┌─────────────────────────────┐
│       server.js             │  ← MCP 서버 진입점
│  createServer(env)          │     도구 등록 + 의존성 주입
│  8개 Tools / 2개 Resources  │
│  1개 Prompt                 │
└──────┬──────────────────────┘
       │
  ┌────┴────────────────────┐
  │                         │
  ▼                         ▼
githubClient.js          aiClient.js
GitHub REST API v3 호출   Claude API 호출
브랜치/PR/이슈/라벨 관리   코드 생성 + 파일 쓰기
git CLI 실행              레포 컨텍스트 수집
```

**의존성 주입 패턴**: 모든 tool handler는 두 번째 인자 `{ _functionName }` 형태로 실제 함수를 주입받습니다. 테스트 시 mock 함수를 주입해 GitHub API / Anthropic API 없이 완전한 단위 테스트가 가능합니다.

```js
// 실제 실행
runCreateBranchTool(args, { token, owner, repo, defaultBase })

// 테스트에서 mock 주입
runCreateBranchTool(args, {
  _getBranchSha: async () => 'sha-abc',
  _createBranch: async () => {},
})
```

---

## 제공 도구

### 이슈 관리

| 도구 | 파라미터 | 설명 |
|------|----------|------|
| `list_labels` | — | 레포에 존재하는 라벨 목록 조회. `create_issue` 전에 먼저 호출 |
| `create_issue` | `title`, `body?`, `labels?` | 이슈 생성. 없는 라벨은 거부하고 사용 가능한 목록 반환 |

### 코드 워크플로우

| 도구 | 파라미터 | 설명 |
|------|----------|------|
| `create_branch` | `name`, `base?` | GitHub 브랜치 생성 (REST API로 원격 브랜치 직접 생성) |
| `run_tests` | `command?`, `cwd?` | 테스트 실행 후 pass/fail + 전체 출력 반환. 허용 명령어만 실행 |
| `commit_and_push` | `message`, `files?` | 변경사항 스테이징 → 커밋 → push |
| `create_pr` | `title`, `body`, `branch`, `base?` | Pull Request 생성 후 URL 반환 |
| `get_pr_review_summary` | `pr_url` | PR 리뷰 승인/변경 요청 수 및 인라인 코멘트 요약 |

### AI 자동화

> `ANTHROPIC_API_KEY` 환경 변수가 없으면 `isError: true` 를 반환하며 비활성 상태가 됩니다.

| 도구 | 파라미터 | 설명 |
|------|----------|------|
| `run_workflow` | `task`, `branch_name?` | **원클릭 자동화** — 브랜치 생성 → AI 코드 작성 → 테스트 (실패 시 최대 3회 자동 수정) → 커밋/push → PR |

---

## 제공 리소스

Tools가 Claude가 실행하는 함수라면, Resources는 Claude가 **읽어오는 데이터 소스**입니다. 대화 시작 전에 첨부하면 Claude가 레포 컨텍스트를 가진 상태로 응답합니다.

| URI | 설명 |
|-----|------|
| `repo://context` | 레포 파일 트리 + 주요 파일 내용. 코드 작성 전 레포 구조 파악에 사용 |
| `repo://recent-prs` | 최근 PR 10개 목록 (제목, URL, 브랜치, 상태). 진행 중인 작업 파악에 사용 |

**Claude Code에서 첨부하는 법**: 대화창에서 `@` 입력 후 URI를 선택합니다.

```
@ repo://context
@ repo://recent-prs
```

---

## 제공 프롬프트

Prompts는 자주 쓰는 지시 패턴을 템플릿으로 등록한 것입니다. Claude Desktop 등에서 `/` 커맨드로 불러올 수 있습니다.

| 이름 | 파라미터 | 설명 |
|------|----------|------|
| `workflow` | `task` | 브랜치 생성 → 코드 작성 → 테스트 → 커밋 → PR 순서를 안내하는 표준 워크플로우 프롬프트 |

**Claude Code에서 사용하는 법**:

```
/workflow task="로그인 버튼 컴포넌트 추가"
```

내부적으로 아래 내용을 Claude에게 전달합니다:

```
Please implement the following task using the github-workflow MCP tools:

**Task:** 로그인 버튼 컴포넌트 추가

Follow these steps in order:
1. Attach the `repo://context` resource to understand the codebase
2. Call `create_branch` with a descriptive branch name
3. Write or modify the necessary files
4. Call `run_tests` to verify correctness
5. Call `commit_and_push` with a clear commit message
6. Call `create_pr` to open a Pull Request
```

---

## 동작 로직

### Part B — 도구 조합 워크플로우 (Claude Code가 직접 조율)

Claude Code가 각 MCP 도구를 순서대로 호출합니다. AI 코딩 없이 사람이 작성한 코드를 Git 워크플로우에 연결할 때 사용합니다.

```
사용자: "feature/login-button 브랜치 만들고 테스트 통과하면 PR 열어줘"

Claude Code
  1. create_branch("feature/login-button")     → GitHub API: refs 생성
  2. (코드 작성은 Claude Code 자체가 수행)
  3. run_tests("npm test")                     → spawn("npm", ["test"], cwd)
     └ 실패 시 Claude Code가 직접 코드 수정 후 재시도
  4. commit_and_push("feat: add login button") → git add . && git commit && git push -u origin HEAD
  5. create_pr("Add login button", ...)        → GitHub API: pulls 생성
```

### Part A — `run_workflow` 원클릭 자동화 (Claude API 내장)

`run_workflow` 도구 하나만 호출하면 모든 단계를 내부에서 처리합니다. AI가 코드까지 작성합니다.

```
사용자: "아바타 업로드 기능 추가해줘"

run_workflow("아바타 업로드 기능 추가")
  │
  ├─ 1. 브랜치 생성
  │     generateBranchName(task) → "feature/아바타-업로드-기능-추가"
  │     getBranchSha(master) → createBranch(feature/...)
  │
  ├─ 2. 코드 생성 루프 (최대 3회 시도)
  │     │
  │     ├─ buildRepoContext(repoPath)
  │     │   └ 파일 트리 수집 (node_modules, .git 제외)
  │     │     우선순위: package.json → *.json/*.md → src/* → 나머지
  │     │     최대 20개 파일, 파일당 32,000자 제한
  │     │
  │     ├─ generateCodeChanges(client, task, context, previousError)
  │     │   └ Claude Sonnet 4.6 호출 (max_tokens: 8192)
  │     │     응답 형식: { explanation, files: [{path, content}] }
  │     │     재시도 시 이전 테스트 실패 출력을 함께 전달
  │     │
  │     ├─ applyFileChanges(repoPath, files)
  │     │   └ 생성된 파일을 디스크에 저장
  │     │
  │     └─ run_tests("npm test", repoPath)
  │         ├ PASS → 루프 종료
  │         └ FAIL → previousTestOutput 저장 후 다음 시도
  │
  ├─ 3. commitAndPush(repoPath, "feat: {task}", ["."])
  │     git add . → git commit -m ... → git push -u origin HEAD
  │
  └─ 4. createPR(task, body, branchName, master)
        → PR URL + number 반환
```

### 라벨 검증 흐름 (`create_issue`)

GitHub는 존재하지 않는 라벨을 이슈 생성 시 자동으로 만들어버립니다 (레포 라벨 오염). 이를 방지하기 위해 사전 검증합니다.

```
create_issue(title, labels=["bug", "없는라벨"])
  │
  ├─ labels가 비어있으면 → 검증 스킵, 바로 생성
  │
  ├─ listLabels(owner, repo) → 레포 라벨 전체 조회
  │
  ├─ 요청 라벨 ∩ 존재 라벨 비교
  │   ├─ 모두 존재 → createIssue() 호출
  │   └─ 없는 라벨 발견 → isError: true 반환
  │         "Label(s) not found: "없는라벨""
  │         "Available labels: bug, enhancement, ..."
  │
  └─ AI가 list_labels 재호출 후 올바른 라벨로 재시도
```

---

## 설치

```bash
git clone https://github.com/GHeeJeon/github-workflow-mcp
cd github-workflow-mcp
npm install
npm link        # 전역 바이너리 등록 (github-workflow-mcp 커맨드 사용 가능)
```

팀 공유 시 npm 패키지로 직접 설치:

```bash
npm install /path/to/github-workflow-mcp
```

---

## Claude Code 연결

`claude mcp add` 명령어로 등록합니다. 프로젝트 디렉토리에서 실행하세요.

```bash
claude mcp add github-workflow \
  -e GITHUB_TOKEN=ghp_your_token_here \
  -e REPO_OWNER=yourorg \
  -e REPO_NAME=your-project \
  -e REPO_PATH=/Users/you/projects/your-project \
  -e DEFAULT_BASE_BRANCH=main \
  -- github-workflow-mcp
```

`run_workflow` (AI 자동화)까지 사용하려면 `ANTHROPIC_API_KEY`를 추가합니다:

```bash
claude mcp add github-workflow \
  -e GITHUB_TOKEN=ghp_your_token_here \
  -e REPO_OWNER=yourorg \
  -e REPO_NAME=your-project \
  -e REPO_PATH=/Users/you/projects/your-project \
  -e ANTHROPIC_API_KEY=sk-ant-your_key_here \
  -- github-workflow-mcp
```

연결 확인:

```bash
claude mcp list
# github-workflow: github-workflow-mcp - ✔ Connected
```

---

## 환경 변수

| 변수 | 필수 | 설명 |
|------|------|------|
| `GITHUB_TOKEN` | ✓ | GitHub Personal Access Token (`repo` 스코프 필요) |
| `REPO_OWNER` | ✓ | 대상 레포 owner (예: `myorg`) |
| `REPO_NAME` | ✓ | 대상 레포 이름 (예: `my-project`) |
| `REPO_PATH` | ✓ | 로컬 레포 절대 경로 (예: `/Users/me/my-project`) |
| `DEFAULT_BASE_BRANCH` | — | 기본 베이스 브랜치 (기본값: `main`) |
| `ANTHROPIC_API_KEY` | — | Claude API 키 (`run_workflow` 도구에만 필요) |

GitHub Token 발급: **Settings → Developer settings → Personal access tokens → `repo` 스코프 체크**

---

## 사용 방법

### Part B — 단계별 지시 (도구 조합)

Claude Code에서 자연어로 지시하면 MCP 도구를 순서대로 호출합니다.

```
"feature/login-button 브랜치를 만들고, 로그인 버튼 컴포넌트를 작성한 뒤
테스트 통과하면 PR까지 열어줘."
```

Claude Code가 자동으로 호출하는 순서:

1. `create_branch("feature/login-button")`
2. _(Claude Code 자체가 코드 작성)_
3. `run_tests("npm test")` — 실패 시 코드 수정 후 재시도
4. `commit_and_push("feat: add login button")`
5. `create_pr("Add login button", "...", "feature/login-button")`

### Part A — 원클릭 자동화 (`run_workflow`)

```
"run_workflow로 '사용자 프로필 페이지에 아바타 업로드 기능 추가' 해줘"
```

내부에서 Claude API가 코드를 작성하고 테스트까지 통과시킵니다.

### 이슈 생성

```
"bug 라벨로 '로그인 버튼이 클릭되지 않음' 이슈 만들어줘"
```

Claude Code가 자동으로 호출하는 순서:

1. `list_labels()` — 사용 가능한 라벨 확인
2. `create_issue("로그인 버튼이 클릭되지 않음", labels=["bug"])`

### PR 리뷰 확인

```
"https://github.com/myorg/repo/pull/42 리뷰 상태 알려줘"
```

`get_pr_review_summary` 가 승인 수 / 변경 요청 수 / 인라인 코멘트를 요약해 반환합니다.

### Resources — 레포 컨텍스트 첨부

Tools를 호출하기 전에 Resource를 첨부하면 Claude가 레포 구조를 파악한 상태로 작업을 시작합니다.

```
@ repo://context 첨부 후:
"위 구조를 보고 인증 모듈에 refresh token 기능을 추가해줘"
```

```
@ repo://recent-prs 첨부 후:
"현재 진행 중인 PR 중 리뷰어가 없는 것 있어?"
```

두 Resource를 함께 첨부하면 Claude가 레포 구조와 진행 중인 PR을 동시에 파악합니다:

```
@ repo://context  @ repo://recent-prs
"현재 작업 중인 PR과 겹치지 않도록 새 브랜치 만들어서 다크모드 지원 추가해줘"
```

### Prompt — 워크플로우 템플릿

`workflow` 프롬프트는 전체 단계 안내를 자동으로 포함합니다:

```
/workflow task="사용자 프로필 이미지 업로드 기능 추가"
```

`run_workflow` 와의 차이: `workflow` 프롬프트는 Claude Code 자체가 코드를 작성하는 Part B 방식이고, `run_workflow` 는 내장 Claude API가 코드까지 생성하는 Part A 방식입니다.

---

## 테스트

```bash
npm test
```

26개 단위 테스트가 포함되어 있습니다. 모든 테스트는 GitHub API / Anthropic API를 호출하지 않으며 의존성 주입으로 완전히 mock 처리됩니다.

| 커버리지 영역 | 테스트 수 |
|-------------|---------|
| `isDirectExecution` | 2 |
| `list_labels` | 2 |
| `create_issue` (라벨 검증 포함) | 4 |
| `create_branch` | 2 |
| `run_tests` (허용 명령어 검증 포함) | 4 |
| `commit_and_push` | 2 |
| `create_pr` | 2 |
| `get_pr_review_summary` | 2 |
| `run_workflow` (재시도 루프 포함) | 5 |
| **합계** | **26** |

---

## 보안

- **명령어 허용 목록**: `run_tests`의 `command` 파라미터는 `npm test`, `yarn test`, `pnpm test`, `python -m pytest`만 허용합니다. 임의 셸 명령어 실행을 차단합니다.
- **라벨 사전 검증**: `create_issue`는 존재하지 않는 라벨 요청을 API 호출 전에 거부합니다. GitHub의 자동 라벨 생성(레포 오염)을 방지합니다.
- **경로 고정**: `REPO_PATH`는 MCP 설정에서 명시적으로 지정합니다. 런타임에 임의 경로를 전달할 수 없습니다.
- **토큰 범위 최소화**: `GITHUB_TOKEN`은 `repo` 스코프만 필요합니다. 각자 개인 PAT를 사용하면 커밋이 본인 이름으로 기록됩니다.
