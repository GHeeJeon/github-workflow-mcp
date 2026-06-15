# github-workflow-mcp

Claude Code에 자연어 지시 한 번으로 GitHub 워크플로우(브랜치 생성 → 테스트 → 커밋/push → PR)를 자동화하는 MCP 서버.

## 제공 도구

### 이슈 관리

| 도구 | 파라미터 | 설명 |
|------|----------|------|
| `list_labels` | — | 레포에 존재하는 라벨 목록 조회. `create_issue` 전에 먼저 호출 |
| `create_issue` | `title`, `body?`, `labels?` | 이슈 생성. 없는 라벨은 거부하고 사용 가능한 목록 반환 |

### 코드 워크플로우

| 도구 | 파라미터 | 설명 |
|------|----------|------|
| `create_branch` | `name`, `base?` | GitHub 브랜치 생성 |
| `run_tests` | `command?`, `cwd?` | 테스트 실행 후 pass/fail + 전체 출력 반환. 허용 명령어만 실행 |
| `commit_and_push` | `message`, `files?` | 변경사항 스테이징 → 커밋 → push |
| `create_pr` | `title`, `body`, `branch`, `base?` | Pull Request 생성 후 URL 반환 |
| `get_pr_review_summary` | `pr_url` | PR 리뷰 승인/변경 요청 수 및 인라인 코멘트 요약 |

### AI 자동화 (ANTHROPIC_API_KEY 필요)

| 도구 | 파라미터 | 설명 |
|------|----------|------|
| `run_workflow` | `task`, `branch_name?` | **원클릭 자동화** — 브랜치 생성 → AI 코드 작성 → 테스트 (실패 시 최대 3회 자동 수정) → 커밋/push → PR |

## 설치

```bash
# 이 레포를 클론한 후
npm install
npm link   # 또는 팀 레포에서: npm install /path/to/github-workflow-mcp
```

## 환경 변수

| 변수 | 필수 | 설명 |
|------|------|------|
| `GITHUB_TOKEN` | ✓ | GitHub Personal Access Token (repo 스코프) |
| `REPO_OWNER` | ✓ | 대상 레포 owner (예: `myorg`) |
| `REPO_NAME` | ✓ | 대상 레포 이름 (예: `my-project`) |
| `REPO_PATH` | ✓ | 로컬 레포 절대 경로 (예: `/Users/me/my-project`) |
| `DEFAULT_BASE_BRANCH` | - | 기본 베이스 브랜치 (기본값: `main`) |
| `ANTHROPIC_API_KEY` | - | Claude API 키 (`run_workflow` 도구에만 필요) |

GitHub Token 발급: Settings → Developer settings → Personal access tokens → `repo` 스코프 체크

## Claude Code 설정

`~/.claude/settings.json` 또는 `.claude/settings.json`에 추가:

```json
{
  "mcpServers": {
    "github-workflow": {
      "command": "github-workflow-mcp",
      "env": {
        "GITHUB_TOKEN": "ghp_your_token_here",
        "REPO_OWNER": "myorg",
        "REPO_NAME": "my-project",
        "REPO_PATH": "/Users/me/projects/my-project"
      }
    }
  }
}
```

## 사용 예시

Claude Code에 다음과 같이 지시하면 됩니다:

```
로그인 버튼 기능을 추가해줘.
feature/login-button 브랜치를 만들고, 코드 작성 후 테스트 통과하면 PR까지 열어줘.
```

Claude Code가 자동으로 아래 순서로 MCP 도구를 호출합니다:

1. `create_branch("feature/login-button", "main")`
2. _(코드 작성)_
3. `run_tests()` → 실패 시 코드 수정 후 재시도
4. `commit_and_push("feat: add login button")`
5. `create_pr("Add login button", "...", "feature/login-button")`

## 테스트

```bash
npm test
```

## run_workflow 사용 예시 (Part A)

`ANTHROPIC_API_KEY`만 추가로 설정하면 완전 자동화 도구가 활성화됩니다:

```json
{
  "mcpServers": {
    "github-workflow": {
      "command": "github-workflow-mcp",
      "env": {
        "GITHUB_TOKEN": "ghp_your_token_here",
        "REPO_OWNER": "myorg",
        "REPO_NAME": "my-project",
        "REPO_PATH": "/Users/me/projects/my-project",
        "ANTHROPIC_API_KEY": "sk-ant-your_key_here"
      }
    }
  }
}
```

Claude Code에 한 마디만 하면 됩니다:

```
run_workflow로 "사용자 프로필 페이지에 아바타 업로드 기능 추가" 해줘
```

내부 동작:
1. `feature/사용자-프로필-페이지에-아바타` 브랜치 자동 생성
2. Claude API가 코드 작성
3. 테스트 실행 → 실패 시 Claude가 자동 수정 (최대 3회)
4. 커밋 + push + PR 오픈

## 보안 참고

- `run_tests`의 `command` 파라미터는 `npm test`, `yarn test`, `pnpm test`, `python -m pytest`만 허용
- `GITHUB_TOKEN`은 각자 개인 PAT를 사용 (커밋이 본인 이름으로 기록됨)
- `REPO_PATH`는 MCP 설정에서 명시적으로 지정 (임의 경로 접근 방지)
