import 'server-only';
import type { ProgressSnapshot } from '../../content/progress';

/**
 * 대표 전용 진행판(/admin/progress)의 서버 전용 상태 스냅샷.
 * - 자동 연동 없음: PR 완료 보고 → PM 검수 후 이 파일만 갱신한다(docs/PROGRESS-SNAPSHOT.md).
 * - checkedAt은 근거 검증(같은 커밋 CI + PM 확인)의 시각이다. 페이지를 연 시각이 아니다.
 * - 화면용 업무 상태만 둔다. 커밋 해시·저장소 주소·로그·오류 원문·토큰·키·DB 설정·고객·수수료·재무 정보는 넣지 않는다.
 * - 실제 영업 접수 실적은 이 파일로 만들지 않는다(확인된 집계가 없으면 '미확인').
 */
export const PROGRESS_SNAPSHOT: ProgressSnapshot = {
  checkedAt: '2026-11-16T03:36:00+09:00', // PM 검수 댓글(2026-11-15T18:36Z)에서 같은 커밋 CI 성공·원문 확인
  staleAfterHours: 24,
  stage: '1단계 — 관리자 로그인·보안 준비 (서비스 비공개, 고객 접수 꺼짐)',
  recentDone: [
    '대표 전용 진행 상황 화면(이 화면)',
    '검색 노출 준비 — 공개 전까지 검색 차단 유지',
    '광고 지표 계산 기준과 출시 준비 문서, 상담 멘트 보관',
    '관리자 로그인 절차와 가상 데이터 상담 목록 조회',
  ],
  next: [
    '좁은 화면(320px) 검사·광고 지표 입력 검증 보완 검수',
    '총판 공식 접수 경로 확보(광고 시작 전 필요)',
    '로그인 시도 제한·인증 앱 등록 구현 승인 여부 결정',
  ],
  checks: [
    { name: '기능 단위 검사', passed: true },
    { name: '화면·API 경로 검사(건너뜀 없음)', passed: true },
    { name: 'DB 보안 검사', passed: true },
    { name: '실제 로그인 서버 연결 검사', passed: null },
  ],
  sales: { label: '실제 상담 접수 실적', value: null }, // 확인된 집계 없음 → 화면에 '미확인'
};
