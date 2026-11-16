# 일일 정책 검수 저장소 — 구현 설계 (PM 6906407187)

**상태: 설계 문서.** 스키마·권한·API·UI·`.env`·workflow·원격 설정은 바꾸지 않았다. **검수 저장소와 그 권한은 아직 구현되지 않았다.**

현재 견적 판정은 순수 함수 `src/server/policies/quotePolicy`(계약: `docs/POLICY-QUOTING-CONTRACT.md`)뿐이다. 그 입력을 채울 저장소가 없으므로, 이 문서는 그 앞단을 설계한다. 실제 공급처 자료·금액·연락처는 넣지 않는다. 예시는 모두 가상이다.

## 1. 현재 스키마 대조 (0001~0006 원문 기준)

| 항목 | 현재 | 정책 저장소에 쓰는 방법 |
|---|---|---|
| 직원·역할 `core.staff` | `role ∈ {owner, counselor, policy_editor, reviewer}`, `active` | 그대로 사용. 새 역할 없음 |
| 관리자 세션 `security.staff_sessions` + `security.assert_staff(actor, session, token, allowed[])` | aal2 서명 + DB 세션 + 12시간 + 활성 직원 + 역할 확인 | 모든 정책 쓰기·읽기 함수의 첫 줄 |
| 감사 `core.audit_logs` | `(at, actor_id, action, target_type, target_id uuid, reason, detail jsonb)`, `fideon_api`는 추가만(갱신·삭제 권한 회수) | 정책 행위 기록. `detail`에는 허용 목록 필드만(5절) |
| 설정 `core.settings` | 키-값(jsonb) | 사용하지 않음(정책은 별도 테이블) |
| 기능 스위치 `core.feature_flags` | `policy_publish` 키가 **이미 있고 기본 `false`**. `api.set_feature_flag`는 owner + 사유 필수 + 감사 | 승인과 별개. 승인이 이 스위치를 켜지 않는다(4절) |
| 상품 `core.product_catalog` | `internet_tv`만 `active`, 나머지 reserved. 보호 트리거·2인 승인(0004·0005) | 정책 레코드의 `category`는 이 키를 참조(FK). 비활성 상품 정책은 저장할 수 있어도 견적 단계에서 거부 |
| 정책 저장소 | **없음** | 새로 필요(2절) |
| 서명 목적 `security.server_keys.purpose` | `staff`·`lead`(0007 초안의 `login`은 미승인) | 새 목적 불필요. 직원 요청은 기존 `staff` 서명 + DB 세션 |

## 2. 새 저장 항목 (제안 — 미구현)

### 2-1. `core.policy_versions` (불변 버전 행)
| 열 | 형 | 뜻 |
|---|---|---|
| `id` | uuid PK | |
| `policy_key` | text, 생성 열 = `supplier_id|segment|carrier|product_id` | 같은 키 묶음 |
| `supplier_id`·`segment`·`carrier`·`product_id` | text(코드 형식 check) | 섞지 않는 구분값 |
| `category` | text FK → `core.product_catalog` | |
| `revision` | int | 키별 1부터 증가. `unique(policy_key, revision)` |
| `based_on_revision` | int null | 어느 승인 버전을 바탕으로 만든 초안인지(낙관적 동시성) |
| `state` | text: `draft` / `submitted` / `approved` / `rejected` / `superseded` / `withdrawn` | |
| `source_kind` | text(견적 계약과 같은 enum) | |
| `confirmed_at`·`valid_from`·`valid_until` | timestamptz(종료 null = 모름) | 공급처가 확인한 값만. 자동 생성 없음 |
| `product_label` | text(≤80) | 고객 안내용 |
| `terms` | jsonb, check로 형태 고정 | 금액·VAT·약정·장비·설치비·결합·지역·혜택(견적 계약의 `Known` 구조) |
| `content_hash` | text | `terms`·시각·라벨의 정규화 해시(중복 승인 판별) |
| `created_by`·`created_at` | | |
| `submitted_by`·`submitted_at` | | |
| `decided_by`·`decided_at`·`decision_reason` | | 승인·반려자, 사유(필수) |
| `superseded_by`·`superseded_at` | | 교체 관계 |

**불변 규칙(트리거):** `approved`가 된 행의 `terms`·시각·라벨·구분값은 갱신할 수 없다. 이후 바뀔 수 있는 것은 `state`를 `superseded`로 바꾸는 전이와 그에 딸린 열뿐이다. 삭제는 금지한다(0004 승인 기록 보호 트리거와 같은 방식).

### 2-2. `security.policy_internal` (서버 전용, 고객·상담원 경로 없음)
| 열 | 뜻 |
|---|---|
| `version_id` FK | |
| `commission_krw` int null | 내부 수수료 |
| `source_ref` text null | 원문 위치 참조. **원문 자체는 저장하지 않는다.** 파일 원문은 Git·DB에 넣지 않고, 사용자의 보관 장소 위치 식별자만 둔다 |

- `security` 스키마에 둔다. `app_staff` 함수 중 owner 전용 조회 1개만 접근한다.
- 견적·고객 DTO·상담원 조회 함수는 이 테이블을 읽지 않는다.

### 2-3. 공통
- RLS + FORCE, `fideon_api`만 정책·권한을 가진다(현 `zz_grants` 방식).
- 앱 역할 테이블 권한 0. 모든 접근은 SECURITY DEFINER `api.policy_*` 함수로 한다.

## 3. 상태 전이와 권한

### 3-1. 전이표
| 현재 | 행위 | 다음 | 허용 역할 | 조건 |
|---|---|---|---|---|
| (없음) | 초안 작성 | `draft` | policy_editor, owner | `based_on_revision` = 현재 승인 revision(없으면 null) |
| `draft` | 수정 | `draft` | 작성자 본인, owner | `expected_revision` 일치 |
| `draft` | 제출(확인 요청) | `submitted` | 작성자 본인, owner | 형태 검증 통과(견적 계약의 정규화 검사와 같은 규칙) |
| `draft`·`submitted` | 철회 | `withdrawn` | 작성자 본인, owner | |
| `submitted` | 승인 | `approved` | **owner** | 4절 검사 전부. 같은 트랜잭션에서 대상 승인본을 `superseded`로 |
| `submitted` | 반려 | `rejected` | owner | 사유 필수 |
| `approved` | 교체 | `superseded` | (승인 트랜잭션 안에서만) | 새 승인본이 같은 키·겹치는 유효 구간을 대체할 때 |
| `approved` | 수정 | — | **불가** | 새 초안을 만든다 |

### 3-2. 권한표 (제안 기본값)
| 역할 | 초안 작성·제출 | 승인·반려·교체 | 승인된 고객 DTO 조회 | 내부 필드(수수료·원문 위치) | 감사 조회 |
|---|---|---|---|---|---|
| owner | ○ | ○ | ○ | ○(owner 전용 함수) | ○ |
| policy_editor | ○(자기 초안) | × | ○ | ×(입력만, 조회 불가) | × |
| counselor | × | × | ○(**승인·유효한 것의 고객 DTO만**) | × | × |
| reviewer | × | × | ○ | × | ○(읽기 전용, 내부 금액 제외) |

**1인 운영 owner 경로:** 두 번째 직원을 필수로 만들지 않는다. owner가 직접 작성하고 승인할 수 있다. 대신 승인 함수가 다음을 요구하고 감사에 남긴다.
- `self_approval = true` 표시
- **확인 항목 체크**: 공급처 원문 대조, 유효 기간, VAT, 혜택 지급·환수 조건, 지역·결합 전제
- 사유(2~500자)

policy_editor가 작성한 초안은 owner가 승인한다. 자기 초안을 승인할 수 있는 역할은 owner뿐이다.

## 4. 서버 재검사 지점 (클라이언트 값 신뢰 안 함)

| 지점 | 재검사 |
|---|---|
| 모든 `api.policy_*` 진입 | `security.assert_staff`(서명·세션·12시간·활성·역할). 요청의 역할·`approved`·작성자 값은 받지 않는다(DB 세션의 직원으로 결정) |
| 초안 수정·제출·승인 | `expected_revision`(행) = 현재 값. 다르면 `REVISION_CONFLICT` |
| 승인 | ① `state = submitted` ② `based_on_revision` = 현재 승인 revision(아니면 `STALE_BASE`) ③ 형태·시각 엄격 검증(견적 계약과 같은 규칙) ④ `confirmed_at ≤ now` ⑤ **같은 키에서 유효 구간이 겹치는 다른 승인본**은 이번 승인으로 교체되는 대상만 허용(그 외는 `OVERLAP_CONFLICT`) ⑥ 1인 경로 확인 항목 ⑦ 사유 |
| 견적 생성(매번) | 승인·유효 버전만 읽어 `quotePolicy(records, request, now)`로 다시 판정. 현재 시각·유효 구간·상충·지역·결합·비활성 상품을 매번 검사한다. **이전 견적을 캐시해 재사용하지 않는다** |
| 기능 스위치 | 승인돼도 `policy_publish`·`lead_form`·상담 스위치는 **자동으로 켜지지 않는다.** 견적을 고객 경로에 쓰는 함수는 `policy_publish`가 켜져 있을 때만 동작한다. 켜기는 기존 `api.set_feature_flag`(owner + 사유 + 감사) 별도 행위 |

## 5. 모델 분리 (필드 허용 목록)

| 모델 | 필드 | 쓰는 곳 |
|---|---|---|
| 내부 검수 모델 | 2-1 전체 + 2-2(owner 함수에서만) | 정책 편집 화면(owner·policy_editor), 승인 함수 |
| 상담원·고객 DTO | `quotePolicy`의 `CustomerQuote` 12개 키 | 상담 화면(counselor), 향후 고객 안내 |
| 감사 조회 모델 | `at, actor_id, action, target_id(version_id), reason, detail{policy_key, revision, from_state, to_state, content_hash, self_approval, checklist[]}` | reviewer·owner |

**감사 기록에 넣지 않는 것:** 원문, 연락처, 수수료 금액, `terms` 전체 사본. 변경 내용은 `content_hash`와 revision으로 추적하고, 실제 값은 불변 버전 행에서 조회한다.

**자유 문구(상품명·지급 조건·환수 조건) 확인 절차**
- 형식 검사(길이·제어 문자)는 서버가 한다. 이것으로 내용 정확성·개인정보 부재를 보장하지 않는다.
- 내용 확인은 승인 체크리스트의 "고객 안내 문구에 개인 연락처·고객 정보·내부 금액 없음" 항목을 owner가 확인하는 사람 절차다.

**원문이 새지 않는 경로**
- 공급처 파일은 Git·DB·로그·고객 응답에 넣지 않는다. `source_ref`에는 위치 식별자만 둔다.
- 서버 로그에 `terms`·원문을 기록하지 않는다. 오류는 코드만 남긴다.

## 6. 버전·동시성·원자성

**교체(승인)는 한 트랜잭션**으로 한다.
1. `pg_advisory_xact_lock(hashtextextended('fideon.policy:' || policy_key, 0))`
2. 대상 행 `for update`
3. 4절 검사
4. 새 행 `approved`
5. 겹치는 이전 승인본 `superseded`(`superseded_by` 기록)
6. 감사 2건(approve, supersede)
7. 커밋

어느 단계든 실패하면 전부 롤백되고, 이전 승인본이 그대로 유효하다.

| 상황 | 처리 |
|---|---|
| 동시 편집 | `expected_revision` 불일치면 `REVISION_CONFLICT`. 덮어쓰지 않는다 |
| 동시 승인(서로 다른 초안) | 키 잠금으로 직렬화한다. 두 번째 승인은 `based_on_revision`이 이제 낡았으므로 `STALE_BASE` |
| 중복 승인 재시도(같은 초안) | 이미 `approved`이고 같은 `content_hash`·같은 요청 ID면 이전 결과를 그대로 반환(멱등). 다르면 `ALREADY_DECIDED` |
| 같은 유효 구간의 상충 승인 | 교체 대상이 아닌 승인본과 구간이 겹치면 `OVERLAP_CONFLICT`. 견적 단계도 `CONFLICTING_VERSIONS`로 이중 차단 |
| 미래 시작 정책 | 승인 가능(사전 공지). 현재 승인본은 새 버전의 `valid_from` 전까지 유효하다. 현재 승인본의 종료를 자동으로 당기지 않는다. 겹침은 owner가 현재 승인본의 종료를 **공급처 확인 값으로** 정한 새 버전을 승인해 해소한다 |
| 변경 중 실패 | 트랜잭션 롤백. 부분 교체 없음 |
| 종료·가격 자동 생성 | **하지 않는다.** 모든 시각·금액은 사람이 공급처 확인 값으로 넣는다 |

멱등 키는 승인 요청의 `request_id`(uuid)이고, `(version_id, request_id)`는 1회만 유효하다.

## 7. 향후 구현 목록 (실행하지 않음)

**파일**
- `db/migrations/00NN_policy_store.sql`: 테이블 2개, 불변 트리거, `api.policy_draft_create/update/submit/withdraw/approve/reject`, `api.policy_quote_source`(승인·유효 버전의 견적 입력만), `api.policy_internal_get`(owner)
- `zz_grants.sql`
  - 새 테이블 `fideon_api` 권한·정책
  - `app_staff` 실행 허용 목록에 위 함수
  - `security.policy_internal`은 `fideon_api`만
- `db/audit/catalog_audit.sql`
  - V5 `exec_allow` 추가
  - 필요하면 V13에 승인 함수 본문 고정
  - 불변 트리거 존재·활성 검사(V10 방식)
- `src/server/policies/store.ts`: DB 행 → `PolicyRecord` 변환. 내부 필드는 견적 경로로 넘기지 않음
- `src/app/admin/policies/*`: 편집·검수 화면. 인증 스위치 하위, owner·policy_editor
- `scripts/db-test.sh` 시험 추가

**실패 시험 기준**
| # | 시험 |
|---|---|
| T1 | counselor·reviewer의 초안 작성 거부, policy_editor의 승인 거부 |
| T2 | policy_editor가 남의 초안 수정 거부 |
| T3 | 1인 owner 자기 승인은 체크리스트·사유 없으면 거부, 있으면 감사에 `self_approval` |
| T4 | 동시 승인 2건 → 1건만 승인, 다른 쪽은 `STALE_BASE` |
| T5 | 승인 중 감사 기록 실패를 유도해 전체 롤백, 이전 승인본 유지 |
| T6 | 승인본 `terms` 갱신·삭제 거부(트리거) |
| T7 | 교체된(superseded) 버전으로 견적 생성 불가, 새 버전만 사용 |
| T8 | 승인됐어도 `policy_publish=false`면 고객 견적 경로 거부 |
| T9 | 클라이언트가 보낸 `state='approved'`·역할 값 무시 |
| T10 | 겹치는 승인본 상충 거부 |
| T11 | 같은 요청 ID 재시도 멱등, 다른 내용 재시도 거부 |
| T12 | 감사 `detail`에 수수료·원문 위치·`terms` 사본 없음 |
| T13 | `security.policy_internal`에 app 역할 직접 접근 불가 |

## 8. 이 문서로 승인되지 않는 것
- 정식 migration
- 권한 변경
- UI·API
- 실제 정책 등록
- `policy_publish`·접수·검색·광고 활성화
- 0007/0008
- 배포
