# 광고 정기 감시 스케줄러 설정안 (PM 11/22, 기준 SHA ebaf253) — 설정안만, 실제 등록·배포 없음

감시 경로: `GET|POST /api/internal/ad-monitor` (`src/app/api/internal/ad-monitor/route.ts`). 기본 닫힘:
`ADMIN_AD_SOURCE=db` + 32자 이상 비밀(`AD_MONITOR_SECRET` 또는 `CRON_SECRET`)이 없으면 503(실행 0회).

## 1. 호출 간격·방식
| 안 | 간격 | 비용 | 판정 |
|---|---|---|---|
| A. Vercel Cron(Pro) `vercel.json` `"crons": [{ "path": "/api/internal/ad-monitor", "schedule": "*/30 * * * *" }]` | 30분(분 단위 정확) | **Pro 요금 필요(대표 결정)** | 권장 — 같은 배포·같은 비밀, `CRON_SECRET` 자동 전송 |
| B. Vercel Cron(Hobby) | **하루 1회만**(시간 단위 미만 표현은 배포 실패), ±59분 지연 | 무료 | **불가** — 1시간 이내 조건 위반 |
| C. 외부 스케줄러(GitHub Actions `schedule` 등) | 30분 지정 | 무료 한도 내 | 보조 — 지연·누락 가능(최선 노력), 비밀을 외부 저장소에 둬야 함 |

- 간격은 **30분**으로 둔다. 1회 누락돼도 다음 회차가 1시간 안, 2회 연속 누락(2시간)이면 DB가 새 집행을 `MONITOR_STALE`로 막는다.
- Vercel 공식 문서: Hobby는 하루 1회·시간 단위 정밀도, Pro는 분 단위([usage & pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing)). 전달은 최선 노력이라 **누락·중복 호출이 생길 수 있고 재시도하지 않는다**, 겹치는 실행은 잠금으로 막으라고 안내([manage cron jobs](https://vercel.com/docs/cron-jobs/manage-cron-jobs)). Cron은 운영(production) 배포에서만 돈다.
- `vercel.json`에는 지금 넣지 않는다(등록 = 배포 승인 사항). 넣는 시점: 대표·PM 승인 + Pro 결정 + 운영 비밀 설정 뒤.

## 2. 인증
- `Authorization: Bearer <비밀>`을 SHA-256 다이제스트로 고정 시간 비교. 비밀 없음·32자 미만·DB 모드 아님 → 503, 불일치 → 401(둘 다 실행 0회).
- Vercel Cron은 `CRON_SECRET`을 자동으로 `Bearer`로 보낸다(배포 시점 값 고정, 변경은 재배포 후 반영). 수동·외부 호출은 `AD_MONITOR_SECRET`.
- 응답에는 캠페인 키·고정 코드만(비밀·외부 ID 없음).

## 3. 중복·겹침·누락 처리
- **중복·겹침**: 회차마다 새 `run_id`. DB `api.ad_monitor_begin`(0022)이 끝나지 않은 회차가 10분 안에 있으면 거부 → 409, 조회·중지·기록 0회. 같은 `run_id` 재사용도 거부. 10분 넘게 끝나지 않은 회차는 실패로 보고 새 회차 허용.
- **중지 동작은 멱등**: 승인 철회·launch paused는 이미 그 상태면 변화 없음, 매체 pause도 이미 중지여도 안전(어댑터 계약).
- **누락**: 마지막 감시 기록이 2시간보다 오래되면 새 집행 `MONITOR_STALE`, 마지막 기록이 정상이 아니면 `MONITOR_NOT_OK`.
- **실패 응답**: 정상 아님 503, 중복 409 → 스케줄러 로그에서 실패로 보인다(Vercel Cron 탭 View Logs).

## 4. 감시 판정(0021·0022, 코드 `src/server/admin/adMonitor.ts`)
- 중지: 계정 시간대 ≠ Asia/Seoul, 기간 기록 없음, 승인 없음·만료, 종료일 경과(4일째 00:00 KST), 날짜별 보고 비용 > 그날 최대 청구액, 계정 보고 합계 ≥ 30,000원.
- UNKNOWN(새 집행 차단): 보고 지연(비용 null), 조회 실패, 불명 launch, 시간대 조회 실패, 중지 실패(경고 → 계정 전체 `STOP_PENDING`).
- 집행 전(adRun): 외부 활성 캠페인 0개, 계정 시간대 Asia/Seoul 확인, DB 기간·한도 판정, 종료일 read-back.

## 5. 상한·예산
- 일 10,000원·누적 30,000원(계정 전체, 날짜별 최대 청구액 기준). DB 함수·검사 제약에 고정 — 화면·입력으로 올릴 수 없다.
- **정산 입금 확인 전 예산 증액 금지.** 증액은 대표 승인 + 정산 입금 확인 + 새 마이그레이션(PM 검수)으로만.

## 6. 미확인(테스트 계정 검증 전)
- 실제 Google의 `end_date_time` 저장·read-back 값 형식, `customer.time_zone` 값, 예산 read-back, 중지 API 응답, 성과 보고 지연 시간 — 모두 가짜 transport로만 시험. **미확인.**
- Vercel 요금제(Pro 여부)·실제 Cron 호출 간격·지연 — 미확인.
