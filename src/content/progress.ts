// 진행판 스냅샷의 형태와 표시 규칙(순수). 서버 데이터는 server/admin/progressSnapshot.ts에만 둔다.
export type ProgressSnapshot = {
  /** 근거 검증 시각(ISO, +09:00). 페이지 열람 시각이 아님 */
  checkedAt: string;
  staleAfterHours: number;
  stage: string;
  recentDone: string[];
  next: string[];
  /** passed: true 통과 / false 실패 / null 미실행·미확인 */
  checks: { name: string; passed: boolean | null }[];
  sales: { label: string; value: number | null };
};

/** 확인 시각이 기준 시간보다 오래됐는가(미래 시각·형식 오류도 오래된 것으로 본다) */
export function isStale(s: Pick<ProgressSnapshot, 'checkedAt' | 'staleAfterHours'>, now: Date): boolean {
  const t = Date.parse(s.checkedAt);
  if (!Number.isFinite(t) || t > now.getTime() + 60_000) return true;
  return now.getTime() - t > s.staleAfterHours * 3_600_000;
}

/** Asia/Seoul 표기(예: 2026. 11. 16. 02:03) */
export function formatSeoul(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '시각 미확인';
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(t));
}
