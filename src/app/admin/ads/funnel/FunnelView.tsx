import { AlertResolve, FunnelConsole } from './FunnelConsole';

export type FunnelItem = {
  campaign: string; impressions: number; clicks: number; costKrw: number; ledgerKrw: number; consults: number; leads: number; overspendDays: number;
  clickRate: number | null; consultRate: number | null; leadRate: number | null; costPerLeadKrw: number | null; overBudget: boolean;
};
export type AlertRow = { id: string; campaign_key: string; state: string; detail: Record<string, unknown>; created_at: string; resolved_at: string | null; resolve_note: string | null };
const won = (n: number | null) => (n === null ? '-' : `${n.toLocaleString('ko-KR')}원`);
const pct = (n: number | null) => (n === null ? '-' : `${(n * 100).toFixed(1)}%`);
const ROLE: Record<string, string> = { owner: '대표', reviewer: '검토자' };

export function FunnelView({ items, role, from, to, alerts = [], alertsError = false }: { items: readonly FunnelItem[]; role: string; from: string; to: string; alerts?: readonly AlertRow[]; alertsError?: boolean }) {
  const open = alerts.filter((a) => a.state === 'open');
  return (
    <main className="admin-main" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
      <header className="admin-bar">
        <span className="brand brand-sm"><span className="brand-mark" aria-hidden="true" />FIDEON 관리 · 광고 성과</span>
        <span className="admin-bar-end"><span className="test-badge">로컬 시험 데이터</span><span className="admin-role">{ROLE[role] ?? role}</span></span>
      </header>
      <p className="muted">
        {from} ~ {to}. 노출 → 클릭 → 상담 시작 → 접수(건수만, 개인정보 없음)와 광고비를 캠페인별로 봅니다. 성과는 <b>모의 광고 플랫폼의 가상 값</b>이며 실제 광고 집행·과금은 연결되어 있지 않습니다.
        상담 시작은 AI 상담창을 연 횟수(세션당 1회)입니다.
      </p>
      {alertsError ? <p role="alert" className="form-result error">경고 목록을 불러오지 못했습니다. 광고 중지 실패 경고가 없다는 뜻이 아닙니다. 새로고침하거나 대표에게 확인하세요.</p> : null}
      {open.length > 0 ? (
        <section aria-label="광고 중지 실패 경고" role="alert" className="admin-card" style={{ borderColor: 'crimson' }}>
          <h2>⚠ 광고 중지 실패 경고 {open.length}건</h2>
          <p>자동 중지가 끝까지 되지 않았습니다. 해결 처리 전에는 해당 캠페인의 지출 판정과 새 승인이 모두 차단됩니다. 광고 플랫폼에서 직접 중지됐는지 확인한 뒤 해결 처리하세요.</p>
          <ul>
            {open.map((a) => (
              <li key={a.id} data-alert-id={a.id}>
                <b>{a.campaign_key}</b> · 승인 철회 {a.detail.revoked === true ? '완료' : '실패'} · 플랫폼 중지 {a.detail.paused === true ? '완료' : '실패'} · {a.created_at.slice(0, 16).replace('T', ' ')}
                {role === 'owner' ? <AlertResolve id={a.id} /> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {role === 'owner' ? <FunnelConsole /> : <p className="muted">이 역할은 조회만 가능합니다.</p>}
      <section aria-label="전환 분석">
        <h2>전환·광고비 분석</h2>
        <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
          <table className="admin-table">
            <thead><tr><th>캠페인</th><th>노출</th><th>클릭</th><th>클릭률</th><th>상담 시작</th><th>상담률(클릭 대비)</th><th>접수</th><th>접수율(상담 대비)</th><th>보고 광고비</th><th>승인 원장</th><th>접수당 비용</th><th>점검</th></tr></thead>
            <tbody>
              {items.length === 0 ? <tr><td colSpan={12}>이 기간의 성과·접수가 없습니다.</td></tr> : items.map((r) => (
                <tr key={r.campaign}>
                  <td>{r.campaign}</td><td>{r.impressions.toLocaleString('ko-KR')}</td><td>{r.clicks.toLocaleString('ko-KR')}</td><td>{pct(r.clickRate)}</td>
                  <td>{r.consults.toLocaleString('ko-KR')}</td><td>{pct(r.consultRate)}</td><td>{r.leads.toLocaleString('ko-KR')}</td><td>{pct(r.leadRate)}</td><td>{won(r.costKrw)}</td><td>{won(r.ledgerKrw)}</td><td>{won(r.costPerLeadKrw)}</td>
                  <td>{r.overBudget ? `승인 밖 지출 의심 ${r.overspendDays}일` : '정상'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

export function FunnelLocked({ kind }: { kind: 'disabled' | 'forbidden' | 'failed' }) {
  const text = { disabled: '광고 성과 화면은 아직 열려 있지 않습니다.', forbidden: '이 화면을 볼 권한이 없습니다.', failed: '불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }[kind];
  return <main className="admin-main"><p role="status">{text}</p></main>;
}
