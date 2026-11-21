import { ApprovePanel, RevokeButton, SpendCheckPanel } from './AdBudgetConsole';

export type BudgetRow = {
  id: string; campaign_key: string; state: string; daily_cap_krw: number; total_cap_krw: number; valid_until: string;
  reason: string; created_at: string; revoke_reason: string | null; spent_today: number; spent_total: number;
};
const won = (n: number) => `${n.toLocaleString('ko-KR')}원`;
const day = (s: string) => s.slice(0, 16).replace('T', ' ');
const ROLE: Record<string, string> = { owner: '대표', reviewer: '검토자' };

export function AdBudgetView({ items, role, caps }: { items: readonly BudgetRow[]; role: string; caps: { dailyKrw: number; totalKrw: number } }) {
  const owner = role === 'owner';
  return (
    <main className="admin-main" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
      <header className="admin-bar">
        <span className="brand brand-sm"><span className="brand-mark" aria-hidden="true" />FIDEON 관리 · 광고 예산</span>
        <span className="admin-bar-end"><span className="test-badge">로컬 시험 데이터</span><span className="admin-role">{ROLE[role] ?? role}</span></span>
      </header>
      <p className="muted">
        승인 없이는 지출이 허용되지 않고, 한도 초과·만료·중복 요청·오류는 모두 차단됩니다. 모든 판정은 감사 기록에 남습니다.
        이 화면은 한도 승인과 판정만 다루며 <b>실제 광고 집행은 연결되어 있지 않습니다.</b>
      </p>
      {owner ? <ApprovePanel dailyMax={caps.dailyKrw} totalMax={caps.totalKrw} /> : <p className="muted">이 역할은 조회만 가능합니다.</p>}
      <section aria-label="승인 목록">
        <h2>승인 내역</h2>
        <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
          <table className="admin-table">
            <thead><tr><th>캠페인</th><th>상태</th><th>한도(일/총)</th><th>지출(오늘/누적)</th><th>유효 기한</th><th>사유</th><th>조작</th></tr></thead>
            <tbody>
              {items.length === 0 ? <tr><td colSpan={7}>승인된 예산이 없습니다. 승인 전에는 모든 지출이 차단됩니다.</td></tr> : items.map((a) => (
                <tr key={a.id}>
                  <td>{a.campaign_key}</td>
                  <td>{a.state === 'active' ? '활성' : '철회'}</td>
                  <td>{won(a.daily_cap_krw)} / {won(a.total_cap_krw)}</td>
                  <td>{won(a.spent_today)} / {won(a.spent_total)}</td>
                  <td>{day(a.valid_until)}</td>
                  <td>{a.state === 'active' ? a.reason : `${a.reason} → 철회: ${a.revoke_reason ?? ''}`}</td>
                  <td>{owner && a.state === 'active' ? <RevokeButton campaign={a.campaign_key} /> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {owner ? <SpendCheckPanel /> : null}
    </main>
  );
}

export function AdBudgetLocked({ kind }: { kind: 'disabled' | 'forbidden' | 'failed' }) {
  const t = { disabled: '광고 예산 통제가 아직 켜져 있지 않습니다.', forbidden: '이 화면을 볼 권한이 없습니다.', failed: '예산 내역을 불러오지 못했습니다.' }[kind];
  return <main className="admin-main"><p role="alert">{t}</p></main>;
}
