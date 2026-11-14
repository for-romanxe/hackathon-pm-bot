# 팀 프로젝트에서 Inky PM봇 쓰기

이 저장소는 [Inky](https://github.com/augmentation-co/inky)에 해커톤에서 사용한 Discord 알림, PR 리뷰와 대시보드를 추가한 버전입니다.

| 기능 | 동작 |
| --- | --- |
| 정각 보고 | 매시 정각에 직전 한 시간의 커밋·PR·이슈를 Discord로 보냅니다. |
| 충돌 알림 | 2분마다 열린 PR의 머지 가능 여부를 확인하고 새로 발견한 충돌을 알립니다. |
| 자동 PR 리뷰 | 2분마다 초안이 아닌 PR을 확인하고 PR별 첫 자동 리뷰만 보냅니다. 완료 기록은 `.inky/pr-auto-reviewed.json`에 남습니다. |
| `/standup` | `discord.standupStartAt`을 지정하면 프로젝트 시작부터 지금까지 보고합니다. 없으면 `windowHours` 범위를 사용합니다. |
| `/openpr` | 열린 PR의 번호와 현재 상태를 보여줍니다. |
| `/pr13`, `/pr 번호:13` | 최신 변경분과 일반 댓글, 리뷰 본문, 인라인 댓글을 읽고 검토합니다. `/pr1`~`/pr95`를 바로 쓸 수 있고, 그 밖의 번호는 `/pr`을 사용합니다. |
| `/dash` | 팀 대시보드 링크를 보여줍니다. 대시보드에서 PR 번호·상태, 머지 비율, 팀 활동을 확인할 수 있습니다. |

명령어 응답은 설정한 채널에 표시됩니다. PR 리뷰는 Discord에만 올라가며 GitHub에 댓글을 달거나 머지하지 않습니다. 변경분이 없을 때와 입력이 50만 자 한도를 넘을 때는 별도로 알려줍니다. Codex CLI를 실행하는 계정의 사용량이 차감되며, PR 변경분과 댓글이 해당 계정의 Codex로 전달됩니다. 자동 요약은 별도 AI 키 없이도 동작합니다.

## 기존 저장소 연결

1. Node.js 22 이상, pnpm 10.33.0을 설치합니다. PR 리뷰를 쓸 경우 같은 머신에 Codex CLI를 설치하고 `codex login status`로 로그인 상태를 확인합니다.
2. 레포를 클론하고 아래 명령으로 빌드합니다. 복사 명령은 macOS/Linux 기준이며 Windows PowerShell에서는 `Copy-Item`을 사용하면 됩니다.

   ```sh
   git clone https://github.com/for-romanxe/hackathon-pm-bot.git
   cd hackathon-pm-bot
   pnpm install --frozen-lockfile --ignore-scripts
   pnpm build
   cp .env.example .env
   cp inky.config.hackathon.example.json inky.config.json
   ```

3. `inky.config.json`에서 `org`와 `repos`를 팀의 GitHub 소유자와 저장소 이름으로 바꿉니다. 필요하면 `discord.standupStartAt`에 시작 시각을 UTC ISO 형식(예: `2027-01-01T00:00:00Z`, 한국 오전 9시)으로 추가합니다.
4. `.env`에 `GITHUB_TOKEN`과 알림 채널의 `DISCORD_WEBHOOK_URL`을 입력합니다. GitHub 토큰은 대상 레포의 Contents, Issues, Pull requests, Metadata 읽기 권한이면 됩니다.
5. 명령도 쓰려면 Discord 앱을 만들어 서버에 `bot` 및 `applications.commands` 범위로 설치합니다. `inky.config.json`의 `discord.applicationId`, `guildId`, `channelId`를 그 앱·서버·채널 ID로 바꾸고 `.env`에 `DISCORD_BOT_TOKEN`을 넣습니다. 명령이 보이지 않으면 서버 설정의 연동 메뉴에서 팀원 권한을 확인합니다. 웹훅 알림만 사용할 경우 명령 등록을 건너뛰면 됩니다.

```sh
node packages/core/dist/cli.js serve --once --dry-run
node packages/core/dist/cli.js register-commands
node packages/core/dist/cli.js serve
```

첫 명령은 GitHub에서 읽어 터미널에 보고서를 출력합니다. 실제 실행은 한 번만 켜두세요. 실행을 종료하거나 컴퓨터가 잠들면 예약 발송이 멈춥니다. 자동 PR 리뷰를 끄려면 `schedule.prReviewCron`을 제거합니다.

## 팀 대시보드 연결 (선택)

대시보드는 저장소 한 곳을 지원합니다. 팀원별 이름을 표시하려면 `launch-team.example.json`을 `launch-team.json`으로 복사하고 `team`을 `[{ "login": "github-id", "name": "이름" }]` 형태로 채웁니다. 시작일은 `discord.standupStartAt` 또는 `launch-team.json`의 `startAt`을 지정하세요. 지정하지 않으면 저장소 전체 이력을 조회합니다.

macOS/Linux에서는 터미널 두 개에서 각각 다음 명령을 실행합니다. 두 프로세스는 같은 데이터 파일을 사용합니다.

```sh
# 터미널 1: GitHub 활동 수집 (약 45초마다)
DASHBOARD_DATA_PATH=.inky/dashboard.json node --env-file=.env dashboard-refresh.mjs inky.config.json --watch

# 터미널 2: 결과 화면 제공
export DASHBOARD_ACCESS_KEY="$(openssl rand -hex 24)"
printf '%s\n' "$DASHBOARD_ACCESS_KEY" # 팀 링크를 만들 때 이 값 사용
DASHBOARD_DATA_PATH=.inky/dashboard.json node dashboard-server.mjs
```

서버 기본 포트는 4182입니다. 재시작해도 같은 링크를 유지하려면 키를 안전하게 보관하고 다음에 같은 값을 설정하세요. 팀원에게 공유하려면 HTTPS 주소를 로컬 포트로 연결하고 `.env`의 `DASHBOARD_JOIN_URL`을 `https://<주소>/join/<접속 키>`로 설정한 뒤 봇을 재시작합니다. 이 링크로 로그인 없이 열 수 있으며, 링크를 전달받은 사람도 볼 수 있습니다. 터널 주소가 바뀌면 `.env`의 링크도 갱신합니다.

## 대회처럼 새 프로젝트를 한 번에 시작 (선택)

GitHub CLI(`gh`)와 `cloudflared`를 설치하고 위의 설정 파일을 준비한 뒤, `launch-team.json`에서 `owner`, 아직 없는 `repo`, `startAt`, 초대할 GitHub 계정 목록 `teammates`를 지정하세요. 자동 등록에도 Discord 명령을 쓰려면 `.env`에 `DISCORD_APPLICATION_ID`와 `DISCORD_BOT_TOKEN`을 함께 넣습니다.

```sh
node launch-team.mjs --check
node launch-team.mjs
```

첫 명령은 읽기 점검만 합니다. 두 번째 명령은 **새 공개 프로젝트 레포**를 만들고 팀원을 초대한 뒤 봇과 대시보드를 백그라운드로 시작합니다. 기존 또는 비공개 프로젝트를 연결할 때는 앞의 수동 설치를 사용하세요. 실행 기록과 PID는 `.inky/`에 저장됩니다.
