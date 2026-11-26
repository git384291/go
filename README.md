# 바른365 (bareun365)

> 공식 도메인(예정): bareun365.com · 내부 코드명: FIDEON (환경변수·검수번호 식별자로 유지)

인터넷·TV·집전화·CCTV 가입 상담 웹앱. 1단계 기반 개발(FIDEON-PM-REV-004 승인 범위).

## 현재 상태

- 고객 화면(메인, 상품 소개 3종, 상담 신청 UI)과 관리자 화면 UI(가상 데이터)
- 상담 신청 API와 관리자 인증 코드는 작성됐지만 **실제 고객정보 수집은 꺼져 있다** (`LEAD_INTAKE_MODE`가 `local`이고 DB가 로컬일 때만 동작)
- DB 마이그레이션, 권한 스크립트, 보안 테스트는 로컬 가상 DB에서 실행된다

## 폴더 구조

```text
db/
  migrations/      0001_security.sql, 0002_leads.sql, zz_grants.sql(매번 마지막에 실행)
  seed/            test_seed.sql (가상 데이터 전용)
  tests/           SQL 보안 테스트(권한 전수 검사, 관리자 인증 공격, 상담 신청·개인정보)
scripts/
  db-test.sh       로컬 PostgreSQL에 새 DB를 만들고 마이그레이션 → 시드 → 테스트
  restore-drill.sh 암호화 덤프 → 복원 → 내용·권한 비교 (가상 데이터)
  sign-parity.ts   TypeScript 서명과 DB 검증 규칙 일치 확인
  preview/         Next.js 없이 페이지를 렌더링해 모바일 화면 캡처
src/
  app/             Next.js App Router 화면과 API(api/leads)
  components/      화면 컴포넌트 (서버 모듈 import 금지)
  content/         상품 소개 문구 (금액·사은품 없음)
  mock/            관리자 화면 가상 데이터
  server/          서버 전용: 서명, 암호화, 상담 신청 처리, 관리자 인증, DB 연결
tests/unit/        node:test 단위 테스트
.github/workflows/ ci.yml, release-check.yml(운영 배포 전 점검만, 배포 권한 없음)
```

## 실행

```bash
npm ci
npm run test:unit      # 단위 테스트
npm run test:db        # 로컬 가상 DB 보안 테스트 (PostgreSQL 16 바이너리 필요)
npm run test:restore   # 복구 훈련
npm run test:preview   # 모바일 화면 캡처 → test-results/screens
npm run dev            # 개발 서버
```

실제 비밀번호·API 키·고객정보는 저장소에 넣지 않는다. 환경변수 목록은 `.env.example`.

## 운영 배포 (REV-005)

- 운영 자동 배포는 꺼져 있다. Vercel 프로젝트 설정의 Production Branch를 존재하지 않는 브랜치 `release-never`로 지정한다. `main` 푸시는 검수(Preview) 배포만 만든다.
- GitHub 비공개 저장소의 Free·Pro·Team 요금제에서는 Environment 필수 승인자를 쓸 수 없다. 그래서 GitHub에는 Vercel 운영 배포 토큰을 두지 않는다.
- 순서는 다음과 같다.
  1. GitHub Actions에서 `release-check`를 실행한다(커밋, 검수 번호 입력). 점검만 하고 배포하지 않는다.
  2. 사용자가 본인 PC에서 `bash scripts/promote-production.sh <검수 배포 URL> <커밋> <검수 번호>`를 실행한다. 본인 Vercel 로그인으로 승격하는 이 단계가 승인이다.
- 실제 배포 환경의 고객 IP 위조 확인: 검수 배포에 `DIAG_IP_ENABLED=1`을 넣은 뒤 `bash scripts/verify-ip-spoofing.sh <검수 배포 URL>`을 실행한다. 확인이 끝나면 이 변수를 지운다.

## 개발 PC(Mac) 통합 검증 (REV-006)
```bash
bash scripts/verify-mac.sh   # 환경 확인 → lockfile 생성 → npm ci → 타입 검사 → ESLint → 단위 테스트 → 빌드 → next start → 실제 브라우저(iPhone 13 WebKit, Galaxy S9+ Chromium) 모바일 검사 → (PostgreSQL 있으면) DB 테스트
```
결과 원문은 `verify-results/<시각>/`에 단계별 로그·스크린샷·summary.txt로 남는다. 실패한 단계도 건너뛰지 않고 종료 코드와 함께 기록한다.
