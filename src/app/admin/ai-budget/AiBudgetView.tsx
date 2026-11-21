import { AiBudgetConsole } from './AiBudgetConsole';

export type AiBudgetData = { role: string; month: string; limitKrw: number; usedKrw: number; unconfirmed: number; maxLimitKrw: number };
const won = (n: number) => `${n.toLocaleString('ko-KR')}원`;
const ROLE: Record<string, string> = { owner: '대표', reviewer: '검토자' };

export function AiBudgetView({ data }: { data: AiBudgetData }) {
  const remaining = Math.max(0, data.limitKrw - data.usedKrw);
  return (
    <main className="admin-main" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
      <header className="admin-bar">
        <span className="brand brand-sm"><span className="brand-mark" aria-hidden="true" />FIDEON 관리 · AI 월 비용 한도</span>
        <span className="admin-bar-end"><span className="test-badge">로컬 시험 데이터</span><span className="admin-role">{ROLE[data.role] ?? data.role}</span></span>
      </header>
      <p className="muted">
        AI 상담 비용은 호출 전에 예약하고 호출 뒤 확정합니다. 한도가 0원이면 유료 AI는 호출되지 않고 안전 안내문으로 답합니다.
        <b> 실제 AI API는 연결되어 있지 않습니다.</b>
      </p>
      <section aria-label="이번 달 사용 현황" className="admin-card">
        <h2>{data.month} 사용 현황</h2>
        <ul>
          <li>월 한도: <b data-field="limit">{won(data.limitKrw)}</b></li>
          <li>사용(확정 + 미정산 예약): <b data-field="used">{won(data.usedKrw)}</b></li>
          <li>남은 한도: <b data-field="remaining">{won(remaining)}</b></li>
          <li>미정산 예약: <b data-field="unconfirmed">{data.unconfirmed}건</b>(정산이 오지 않으면 예약 비용 전액으로 계산)</li>
        </ul>
      </section>
      {data.role === 'owner' ? <AiBudgetConsole max={data.maxLimitKrw} current={data.limitKrw} /> : <p className="muted">이 역할은 조회만 가능합니다.</p>}
    </main>
  );
}

export function AiBudgetLocked({ kind }: { kind: 'disabled' | 'forbidden' | 'failed' }) {
  const text = { disabled: 'AI 비용 한도 화면은 아직 열려 있지 않습니다.', forbidden: '이 화면을 볼 권한이 없습니다.', failed: '불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }[kind];
  return <main className="admin-main"><p role="status">{text}</p></main>;
}
