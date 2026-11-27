// 진행판 스냅샷의 형태와 표시 규칙(순수). 서버 데이터는 server/admin/progressSnapshot.ts에만 둔다.
import type { Ledger, LeadRecord } from './dealerLedger';

/** 가상 연습 집계(실적 아님). 실제 실적(sales)과 따로 표시한다 */
export type Rehearsal = { label: string; total: number; byDay: { day: string; count: number }[] };

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
  rehearsal?: Rehearsal;
};

/** 실적: 실제(REAL) 접수 자료가 입력에 있을 때만 숫자, 없으면 null('미확인'). 모의 확인은 절대 섞지 않는다 */
export function salesFromLedger(leads: readonly LeadRecord[], ledger: Ledger): ProgressSnapshot['sales'] {
  const hasReal = leads.some((l) => l && l.origin === 'REAL');
  return { label: '총판 확인 기준 실제 접수 실적', value: hasReal ? ledger.total.real : null };
}

/** 가상 연습 집계: 모의 칸만 읽는다. 실적이 아니다 */
export function rehearsalFromLedger(ledger: Ledger): Rehearsal {
  const byDay = Object.entries(ledger.byDay).filter(([, c]) => c.mock > 0).map(([day, c]) => ({ day, count: c.mock })).sort((a, b) => a.day.localeCompare(b.day));
  return { label: '가상 연습 집계 (실적 아님)', total: ledger.total.mock, byDay };
}

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
