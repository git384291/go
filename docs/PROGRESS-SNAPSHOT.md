# 대표 전용 진행판 (/admin/progress) — 스냅샷 갱신 절차

## 무엇을 보여 주나
- 현재 단계, 최근 완료, 다음 작업, 검사 통과 여부(통과/실패/미확인), 확인 기준 시각(Asia/Seoul)
- 영업 실적은 개발 진행과 따로 표시한다. 확인된 집계가 없으면 **미확인**이다.
- 진행률, 완료 예정일, "작업 중" 신호는 만들지 않는다.
- 자동 연동은 없다. "확인 기준 · 실시간 아님"을 표시하고, 24시간이 지나면 "갱신 안 됨"을 표시한다.

## 접근
- 인증 스위치가 꺼져 있으면 잠금 화면이다. 상태 데이터를 읽지 않고, 로컬 개발 서버의 가상 화면 우회도 없다.
- 켜져 있으면 `requireStaff()`(DB whoami)를 거쳐 **owner만** 본다.
  - 미인증: 로그인 화면으로 보낸다.
  - counselor·reviewer·policy_editor, MFA 미완료, DB 거부·장애: 거부 화면이다. 스냅샷을 불러오지도 그리지도 않는다.
- 서버 컴포넌트만 쓰고 새 API는 없다. `force-dynamic`이다.
- 응답 헤더와 메타데이터
  - middleware: `Cache-Control: private, no-store`, `X-Robots-Tag: noindex, nofollow`(모든 `/admin`)
  - 페이지 메타데이터: `robots: noindex, nofollow, nocache`
  - 검색 제외는 인증을 대신하지 않는다.

## 갱신 절차 (최소)
1. Claude가 PR에 완료 보고를 올린다. 보고에는 전체 SHA, 같은 SHA의 CI, 경로 시험 skipped 수, 실행·미실행 구분을 담는다.
2. PM이 diff와 같은 SHA의 CI를 직접 확인하고 검수 댓글을 남긴다.
3. 다음 작업 묶음에서 Claude가 `src/server/admin/progressSnapshot.ts`만 고친다.
   - `checkedAt`: PM 검수 댓글이 같은 SHA CI 성공을 확인한 시각(+09:00). **페이지를 연 시각이나 커밋 시각이 아니다.**
   - `stage`, `recentDone`, `next`, `checks`는 업무 문장으로 쓴다.
   - 다음은 넣지 않는다: 커밋 해시, 저장소 주소, CI 링크, 로그, 오류 원문, 토큰, 키, DB 설정, 고객·수수료·재무 정보
   - `sales.value`는 PM·사용자가 확인한 실제 접수 집계가 있을 때만 숫자를 넣는다. 그 외에는 `null`이다.
4. 경로 시험 P6이 스냅샷의 금지 형식을 검사한다(해시처럼 보이는 문자열, URL, 금액·수수료 표현).

## 검증 범위
- `tests/route/admin-progress.test.ts`
  - P1~P6: 판정을 주입해 거부 결과의 요소 트리 전체(렌더 결과·props 재귀)에 스냅샷 문자열이 없는지, owner만 표시되는지 확인한다. 로컬·CI 모두 실행한다.
  - P7: 실제 page.tsx를 인증 기본값으로 실행한다. CI에서만 실행한다.
- 모바일: 미리보기 `08-admin-progress`(고정 예시 데이터)로 320px·390px에서 가로 넘침이 없음을 확인했다.
- **미검증:** 인증이 켜진 실제 Supabase 쿠키로 owner와 비owner가 접속하는 E2E(fideon-dev 연결 후 D12~D13)
