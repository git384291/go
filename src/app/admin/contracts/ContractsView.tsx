import type { ContractItem } from '@/server/admin/contractAdmin';
import { ContractsConsole } from './ContractsConsole';

const won = (n: number) => `${n.toLocaleString('ko-KR')}원`;
const STATUS: Record<string, string> = { scheduled: '설치 예정', installed: '설치 완료', cancelled: '취소', terminated: '해지' };

export function ContractsView({ items, risk, initialLeadId }: { items: ContractItem[]; risk: number; initialLeadId: string }) {
  return (
    <div className="admin">
      <header className="admin-bar">
        <span className="brand brand-sm"><span className="brand-mark" aria-hidden="true" />바른365 관리 · 설치·정산·환수</span>
        <a className="admin-link" href="/admin">상담 목록</a>
      </header>
      <main className="admin-main">
        <p className="read-note">대표 전용입니다. 금액과 상태 변경은 서버에서 다시 검증하고 DB 원장에 추가 기록합니다.</p>
        <section className="admin-card"><b>환수 확인 필요 {risk}건</b></section>
        <ContractsConsole initialLeadId={initialLeadId} />
        {items.length === 0 ? <p role="status">등록된 설치 일정이 없습니다.</p> : (
          <ul className="lead-list" aria-label="설치·정산 목록">
            {items.map((x) => (
              <li className="lead-row" key={x.leadId}>
                <div className="lead-main"><span className="lead-name">{x.nameMasked ?? '이름 가림'}</span><span>{x.carrier}</span></div>
                <div className="lead-meta">
                  <span>예정 {x.installScheduledOn}</span><span>설치 {x.installedOn ?? '-'}</span><span>환수기한 {x.clawbackUntil ?? '-'}</span>
                  <span>입금 {won(x.receivedKrw)}</span><span>환수 {won(x.clawbackKrw)}</span>
                </div>
                <span className={`status status-${x.status}`}>{STATUS[x.status] ?? x.status}{x.clawbackRisk ? ' · 확인' : ''}</span>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

export function ContractsLocked({ text }: { text: string }) {
  return <main className="admin-locked" role="status">{text}</main>;
}
