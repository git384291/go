# FIDEON-PM-REV-005 대응 보고서

- 기준 커밋: 18366e9ea504e684e6508211b41f46ba23af81f0
- 수정 커밋: 이 보고서가 포함된 커밋 (`git log -1`로 확인. 해시는 전달 메시지에 기재)
- 범위 준수: 설계서 재작성 없음, 기술 스택 변경 없음(Next 15.5 유지), AI·정산·TM 기능 없음, 실제 고객정보 수집·운영 배포 없음, 기존 코드 폐기 없음

## 1. 결론 요약

| 항목 | 상태 | 비고 |
|---|---|---|
| 1. 빌드·CI | **일부 완료 / 실행 차단** | lint를 ESLint CLI로 전환. lockfile·npm ci·build·실제 Next 서버·CI 실행은 이 작업 환경에서 패키지 저장소 접속이 막혀 실행 불가 |
| 2. 관리자 인증 통합 | **실행 차단** | Supabase 개발 프로젝트 필요. 자체 세션·토큰 검증 로직은 로컬 DB에서 통과(기존 A 시리즈) |
| 3. 공개 상담 API | **코드 완료 / 실배포 검증 대기** | 신뢰 IP 처리 수정, 위조 헤더 검증 스크립트·진단 경로 추가. 암호화·HMAC·동의 누락 차단·중복 비노출은 로컬 DB 테스트 통과 |
| 4. Supabase 통합 | **실행 차단** | 로컬 PostgreSQL 16에서 역할·RLS+FORCE·SECURITY DEFINER·권한 분리 85/85 통과. Supabase 실환경(풀러 포함) 미검증 |
| 5. 배포 승인 | **완료(설계·코드)** | private 저장소에서 GitHub 환경 승인자 기능을 쓸 수 없음을 확인 → 방식 변경. 운영 자동 배포 비활성 유지 |

## 2. 변경 파일

| 파일 | 변경 |
|---|---|
| `eslint.config.mjs` | ESLint CLI flat config. Next 15용 `FlatCompat`으로 `next/core-web-vitals`, `next/typescript` 적용. 기존 보안 규칙(tx.unsafe 문자열 금지, 화면→서버 모듈 import 금지) 유지 |
| `package.json` | `lint: "eslint ."`, devDependency `@eslint/eslintrc` 추가, `test` 스크립트에 lint 포함 |
| `src/server/http/clientIp.ts` | Vercel에서는 Vercel이 덮어쓰는 `x-real-ip`만 사용, 없거나 형식 오류면 공용 버킷 `0.0.0.0`. 로컬에서만 `x-forwarded-for` 마지막 값 사용 |
| `src/app/api/diag/ip/route.ts` (신규) | 검수 배포 + `DIAG_IP_ENABLED=1`일 때만 열리는 진단 경로. IP 원문 대신 HMAC 앞 8자리만 반환. 그 외 404 |
| `scripts/verify-ip-spoofing.sh` (신규) | 위조 헤더(XFF, x-real-ip, 조합, x-vercel-forwarded-for)를 넣어도 버킷이 같은지 검수 배포에서 확인 |
| `tests/unit/clientIp.test.ts` | T20~T25 (Vercel/로컬 분기, 위조 거부, IPv6, 진단 경로 개방 조건) |
| `.github/workflows/deploy-production.yml` | **삭제** (private 저장소에서 동작하지 않는 승인 방식에 의존) |
| `.github/workflows/release-check.yml` (신규) | 수동 실행. 커밋이 main에 있는지, 해당 커밋 CI 성공 여부, DB 테스트, 운영 DB 권한 점검(읽기 전용 계정). **배포 권한·Vercel 토큰 없음** |
| `scripts/promote-production.sh` (신규) | 사용자 본인 PC에서 실행. release-check 성공 기록과 검수 배포의 커밋 일치를 확인한 뒤 `yes` 입력 시 `vercel promote` |
| `vercel.json` | Git 연동 운영 배포 차단(운영 브랜치를 존재하지 않는 `release-never`로 지정하는 전제). main 푸시는 검수 배포만 생성 |
| `README.md`, `scripts/db-test.sh`, `scripts/db-audit.sh` | 배포 절차 설명·주석 갱신 |
| `docs/REPORT-REV-005.md` | 이 보고서 |

## 3. 항목별 내용

### 3.1 빌드·CI (1항)
- **lint**: Next.js 문서에 따르면 `next lint`는 Next 16에서 제거되었고 ESLint CLI 사용이 권장됨. 기술 스택 변경 금지에 따라 Next 15.5를 유지하고 FlatCompat 방식으로 전환. Next 16 업그레이드 여부는 PM 결정 사항.
- **실행하지 못한 것**: 이 작업 환경은 npm 저장소 접속이 차단되어 `npm install`(lockfile 생성), `npm ci`, `npm run lint`, `npm run build`, `next start` 실행 불가. **package-lock.json은 추측으로 만들지 않았다**(무결성 해시가 틀린 lockfile은 npm ci를 깨뜨림).
- **이 환경에서 실행한 회귀 테스트** (모두 통과):
  - 타입 검사(tsc --noEmit): 오류 0
  - 단위 테스트: 25/25
  - DB 테스트(로컬 PostgreSQL 16): 85/85 (권한 G, 인증 A, 상담 L, 개인정보 P, 세션 S, 동시성 C1~C4, 카탈로그 점검 X1~X6, 정산 테이블 잠금 F1~F3)
  - 화면 미리보기 7개(모바일 폭): 가로 넘침 없음, 금액 표기 0
  - 화면 미리보기는 정적 렌더링 결과이며 **실제 Next.js 서버 화면이 아니다.**

### 3.2 공개 상담 API의 신뢰 IP (3항)
- Vercel 문서: Vercel은 `X-Forwarded-For`를 덮어쓰고 외부에서 보낸 값을 전달하지 않으며, `x-real-ip`도 같은 값.
- 수정 전에는 Vercel에서도 `x-forwarded-for`를 대체 경로로 쓸 수 있었음 → Vercel에서는 `x-real-ip`만 신뢰하도록 수정.
- 실배포 위조 테스트는 검수 배포에서 `scripts/verify-ip-spoofing.sh <검수 URL>`로 실행해야 함(아직 미실행).
- 진단 경로는 운영(`VERCEL_ENV=production`)에서는 환경변수와 무관하게 404.

### 3.3 배포 승인 방식 (5항)
- GitHub 문서: 환경 승인자(required reviewers)·대기 타이머는 Free/Pro/Team 요금제에서 **public 저장소만** 가능. private 저장소는 Enterprise 필요. private 저장소의 환경 비밀값은 Pro/Team/Enterprise 필요.
- 따라서 승인자 기능이 없다는 전제로 변경:
  1. main 푸시 → CI + Vercel 검수 배포(운영 아님)
  2. 사용자가 GitHub에서 `release-check` 수동 실행(커밋, 검수 번호 입력) → 점검만 수행
  3. 사용자가 본인 PC에서 `promote-production.sh` 실행 → 확인 후 `yes` 입력 시 승격
  4. Vercel 승격 시 운영 환경변수로 다시 빌드됨(Vercel 문서)
- 저장소·CI 어디에도 운영 배포 토큰이 없으므로 자동 배포 경로가 없음.
- **사용자 설정 필요**: Vercel 대시보드에서 Production Branch를 `release-never`로 변경.

### 3.4 관리자 인증·Supabase 통합 (2·4항)
- Supabase 계정·프로젝트가 없어 Supabase Auth 로그인, TOTP, 로그인 직후 세션 등록, 커스텀 DB 역할 로그인, 연결 풀러 호환을 실행하지 못함.
- 같은 SQL을 로컬 PostgreSQL 16에서 검증한 결과:
  - 다른 관리자 세션 사용 차단(A 시리즈)
  - 로그아웃(세션 폐기)·만료(12시간) 처리
  - 상담원 간 개인정보 조회 차단(P 시리즈)
  - RLS+FORCE 전 테이블 적용 및 SECURITY DEFINER 실행 권한 허용 목록(X 시리즈)
- `src/server/auth/requireStaff.ts`(Supabase 세션 읽기)는 실제 Supabase 없이는 테스트되지 않은 상태.

## 4. 발견한 오류와 수정
1. **배포 승인 설계 오류**: 기존 `deploy-production.yml`은 private 저장소에서 쓸 수 없는 환경 승인자·환경 비밀값에 의존. → 삭제 후 3.3 방식으로 변경.
2. **vercel.json 설정 오류**: `main: false`로 두면 승격에 필요한 main 검수 배포까지 막힘. → 운영 브랜치를 별도 이름으로 지정하는 방식으로 변경.
3. **IP 대체 경로 위험**: Vercel에서 `x-real-ip`가 없을 때 `x-forwarded-for`로 대체하던 경로 제거.
4. **lint 명령 폐기 예정**: `next lint` → `eslint .`.

## 5. 미해결 사항과 보안 위험
| 구분 | 내용 | 해소 조건 |
|---|---|---|
| 미실행 | lockfile, npm ci, lint, build, 실제 Next 서버 화면, CI 실행 기록 | 패키지 설치가 가능한 환경 또는 GitHub 저장소에서 CI 실행 |
| 미실행 | Supabase Auth·TOTP·세션 등록, 커스텀 역할 로그인, 풀러 호환 | 가짜 데이터 전용 Supabase 개발 프로젝트 |
| 미실행 | 실배포 IP 위조 테스트 | Vercel 검수 배포 + `DIAG_IP_ENABLED=1` |
| 위험(중) | 승격 스크립트는 사용자 PC에서 실행되므로, 사용자의 Vercel 계정을 가진 사람은 스크립트 없이도 대시보드에서 직접 승격할 수 있음. 기술적 강제가 아니라 절차적 통제임 | Vercel 팀 권한 최소화, 승격 기록(`~/.fideon-promotions.log`)과 Vercel 배포 이력 대조 |
| 위험(낮) | 진단 경로가 검수 배포에서 켜져 있는 동안 IP 해시 앞 8자리가 노출됨(원문 IP는 아님) | 검증 후 `DIAG_IP_ENABLED` 제거 |
| 확인 필요 | Vercel GitHub 연동이 남기는 배포 기록 형식(승격 스크립트 2단계) | 첫 사용 때 확인 |

## 6. 출처
- GitHub — Deployments and environments: https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments
- Vercel — Request headers: https://vercel.com/docs/edge-network/headers/request-headers
- Vercel — Promote preview to production: https://vercel.com/docs/deployments/promote-preview-to-production
- Next.js — ESLint: https://nextjs.org/docs/app/api-reference/config/eslint
