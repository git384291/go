# 관리자 세션의 서버 기초 보강

## 문제와 변경

기존 `requireStaff`는 검증된 JWT의 aal2·사용자·세션 ID를 서명해서 반환했지만, 그 시점에는 DB의 직원 활성 상태와 세션 유효성을 확인하지 않았다. `openStaffSession`은 등록 함수의 반환값만 사용하므로 기존 세션이 이미 만료·폐기됐는지 확인하지 않았다.

- `src/server/auth/staffSession.ts`: JWT 입력 검증 후 DB가 본인과 허용 역할을 확인해야만 인증 결과를 반환한다. DB가 거부하거나 응답이 비어 있거나 다른 사용자·알 수 없는 역할을 반환하면 차단한다. DB 장애를 성공으로 대체하지 않는다.
- `src/server/auth/requireStaff.ts`: 일반 요청은 `api.whoami`를 호출한다. 세션 등록은 `api.staff_session_open`과 `api.whoami`를 같은 `withRole` 트랜잭션 안에서 호출한다. 확인 실패는 트랜잭션 밖으로 전파해 등록과 감사 기록도 롤백되게 한다.
- 세션 열기 서명과 일반 요청 서명의 용도 분리를 유지한다. aal1과 잘못된 사용자·세션 ID는 DB 접속 전에 차단한다.
- DB 권한 거부(SQLSTATE 42501)는 내부 SQL 메시지를 포함하지 않는 `StaffAuthError(403, FORBIDDEN)`으로 변환한다.
- 기타 DB 오류도 쿼리·서명 파라미터·접속 정보·원본 cause를 포함하지 않는 `StaffSessionUnavailable`로 변환한다. Claude 검토에서 지적한 향후 로그·오류 응답의 정보 노출 가능성을 서비스 경계에서 차단한다.

## 검증 범위

로컬 전체 타입 검사·ESLint·단위 테스트 50/50·기존 API 경로 테스트 5/5 통과.

새 단위 테스트 10건은 DB 포트를 가짜로 대체해 거부 전파, 잘못된 DB 응답, 사용자 일치·대문자 UUID 정규화, 허용 역할, 호출 순서, 서명 목적 분리, 내부 오류 정보 제거, 트랜잭션 콜백 실패를 확인한다. 실제 PostgreSQL의 롤백이나 Supabase 인증 동작을 실행한 테스트는 아니다. 기존 DB 보안·복구 검증은 변경 커밋의 CI에서 별도로 확인한다.

## 유지한 제한과 다음 작업

- 로그인 화면, 관리자 가상 데이터 화면, 상품·상담 접수 스위치는 변경하지 않았다. DB 마이그레이션과 권한도 변경하지 않았다.
- 이 변경만으로 OI-002를 해결했다고 보지 않는다. 앱 로그인·TOTP·로그아웃 호출 경로와 세션 갱신 처리는 다음 작업이다.
- 실제 Supabase 개발 프로젝트에서 만료·폐기·비활성 직원·다른 사용자 세션·트랜잭션 풀러를 검증해야 한다.
- `requireStaff`의 쿠키 쓰기는 기존처럼 Server Action·Route Handler에서만 사용한다. Server Component 보호를 붙일 때는 쿠키 갱신 경로도 함께 설계한다.
- 실제 고객정보 수집, main 병합, 운영 배포, PHASE 2 활성화는 계속 보류한다.

## 앱 연결 (PM 지시 6896235394 4절)

### 묶음 1 — 실DB 통합 시험 (`5c42b8d`)
- `staffSessionDb.ts`가 whoami·open·revoke SQL 배선을 맡고, `withRoleOn`으로 연결을 주입받는다.
- `tests/integration/staff-session-db.test.ts`(I1~I10)는 `scripts/db-test.sh`의 가상 DB에 `app_server`로 접속해 앱과 같은 코드를 실행한다. 폐기·만료 재등록 시 등록 함수가 남긴 감사 기록까지 롤백되는 것을 대조군과 함께 확인한다.

### 묶음 2 — 로그인·TOTP·로그아웃·세션 갱신
| 구성 | 내용 |
|---|---|
| `adminAuthMode.ts` | `ADMIN_AUTH_MODE=supabase` + Supabase URL·공개 키·직원 서명 키·DB URL이 모두 있을 때만 켠다. 운영(`VERCEL_ENV=production`)은 항상 꺼짐. 꺼져 있으면 `/admin`은 잠기고, 가상 데이터 화면은 로컬 `next dev`에서만 보인다(preview 배포 노출 차단) |
| `loginFlow.ts` | 비밀번호 → TOTP → DB 세션. 계정 없음·비밀번호 오류·TOTP 미등록은 같은 오류. aal2 전에는 DB 세션을 열지 않고, 성공 후 정확히 1회 연다. DB 거부·장애 시 Supabase 로그인도 끝낸다 |
| `admin/actions.ts` | Server Action `loginAction`·`logoutAction`. 스위치가 꺼져 있으면 외부 호출 없이 거부 |
| `admin/page.tsx` | 매 요청 `requireStaff()`(DB `api.whoami`). 실패하면 사유 없이 로그인 화면으로 |
| 로그아웃 | DB 세션 폐기(`api.staff_session_revoke`) → Supabase `signOut`(폐기 실패해도 진행) |
| `src/middleware.ts` | `/admin` 경로만. 인증이 켜져 있으면 접근 토큰 갱신 쿠키를 기록한다. 관리자 응답은 `Cache-Control: private, no-store`. 허용 판단은 하지 않는다 |
| `supabaseServer.ts` | Server Component에서 쿠키 쓰기 예외가 나면 건너뛴다. 갱신은 middleware가 담당한다 |

하지 않은 것: TOTP 최초 등록 화면(대표 입회 절차로 별도 설계), 공개 가입·직원 생성, 실제 리드 조회 API, 실제 Supabase 프로젝트 연결 검증(설정 준비 후).

### 묶음 3 — 로그아웃 실패 표시·middleware 장애 처리
로그아웃 결과 5가지와 middleware 503 처리, 보장의 한계는 [ADMIN-AUTH-OPERATIONS.md](ADMIN-AUTH-OPERATIONS.md) 4절. 시도 제한 조사·서버 제한안(1절), TOTP 등록·복구 절차(2절), fideon-dev 체크리스트(3절)도 같은 문서에 있다.
