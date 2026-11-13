# FIDEON

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
.github/workflows/ ci.yml, deploy-production.yml(GitHub Environment 승인)
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
