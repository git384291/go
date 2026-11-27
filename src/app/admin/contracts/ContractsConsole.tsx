'use client';
import { useState, type FormEvent } from 'react';

type Action = Record<string, string | number>;

export function ContractsConsole({ initialLeadId }: { initialLeadId: string }) {
  const [leadId, setLeadId] = useState(initialLeadId);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function send(payload: Action) {
    setBusy(true); setMessage('저장 중…');
    try {
      const r = await fetch('/api/admin/contracts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const b = await r.json().catch(() => ({})) as { ok?: boolean; code?: string };
      if (!r.ok || !b.ok) { setMessage(`저장 실패: ${b.code ?? 'UNKNOWN'}`); return; }
      setMessage('저장했습니다.');
      window.location.reload();
    } catch { setMessage('연결 오류로 저장하지 못했습니다.'); }
    finally { setBusy(false); }
  }

  const value = (f: FormData, k: string) => String(f.get(k) ?? '');
  const submit = (kind: 'schedule' | 'status' | 'settle') => (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (kind === 'schedule') return void send({ action: 'schedule', leadId, carrier: value(f, 'carrier'), installOn: value(f, 'installOn'), contractMonths: Number(value(f, 'contractMonths')), clawbackMonths: Number(value(f, 'clawbackMonths')) });
    if (kind === 'status') {
      const status = value(f, 'status');
      return void send(status === 'cancelled' ? { action: 'status', leadId, status } : { action: 'status', leadId, status, on: value(f, 'on') });
    }
    void send({ action: 'settle', leadId, kind: value(f, 'kind'), amountKrw: Number(value(f, 'amountKrw')), on: value(f, 'on') });
  };

  return (
    <section className="admin-card" aria-label="설치·정산 입력">
      <label className="field"><span>리드 ID</span><input required value={leadId} onChange={(e) => setLeadId(e.target.value)} placeholder="상담 목록의 UUID" /></label>
      <div className="contract-forms">
        <form onSubmit={submit('schedule')}>
          <h3>설치 일정</h3>
          <select name="carrier" defaultValue="KT"><option>KT</option><option>SKB</option><option>LGU</option><option>OTHER</option></select>
          <input name="installOn" type="date" required />
          <input name="contractMonths" type="number" min="1" max="60" defaultValue="36" required aria-label="약정 개월" />
          <input name="clawbackMonths" type="number" min="0" max="60" defaultValue="12" required aria-label="환수 개월" />
          <button className="btn btn-primary" disabled={busy || !leadId}>일정 저장</button>
        </form>
        <form onSubmit={submit('status')}>
          <h3>설치·해지 상태</h3>
          <select name="status" defaultValue="installed"><option value="installed">설치 완료</option><option value="terminated">해지</option><option value="cancelled">취소</option></select>
          <input name="on" type="date" aria-label="처리일" />
          <button className="btn btn-primary" disabled={busy || !leadId}>상태 저장</button>
        </form>
        <form onSubmit={submit('settle')}>
          <h3>정산·환수</h3>
          <select name="kind" defaultValue="received"><option value="received">정산 입금</option><option value="clawback">환수</option></select>
          <input name="amountKrw" type="number" min="0" step="1" required placeholder="금액(원)" />
          <input name="on" type="date" required aria-label="처리일" />
          <button className="btn btn-primary" disabled={busy || !leadId}>금액 저장</button>
        </form>
      </div>
      <p role="status" className="hint">{message}</p>
    </section>
  );
}
