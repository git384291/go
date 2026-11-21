'use client';
import { useState } from 'react';

export type HandoffRow = { event: string; note: string | null; actorId: string; createdAt: string };
type Amendment = { createdAt: string; changes: { key: string; label: string; before: string; after: string }[] };
type Packet = { status: 'ready' | 'incomplete' | 'notice_pending'; missingLabels: string[]; dealerOnly: { key: string; label: string; note: string }[]; text: string };
const REASONS = [['dealer_handoff', '총판 전달 준비'], ['content_check', '내용 확인'], ['correction', '정정 확인']] as const;
const STATUS: Record<Packet['status'], string> = { ready: '총판 전달 준비 완료', incomplete: '준비 미완료 — 고객 정보 누락', notice_pending: '준비 미완료 — 필수 고지 확인 미완료' };
const EV: Record<string, string> = { viewed: '열람', copied: '복사', sent: '총판 전달 완료' };

// 총판 전달용 신청서 확인·복사. 권한은 서버·DB가 매번 판정한다(화면은 정하지 못함). 열람은 사유가 필요하고 이력·감사에 남는다.
export function PacketConsole({ leadId, history }: { leadId: string; history: readonly HandoffRow[] }) {
  const [reason, setReason] = useState('dealer_handoff');
  const [packet, setPacket] = useState<Packet | null>(null);
  const [amend, setAmend] = useState<{ items: Amendment[]; error: boolean }>({ items: [], error: false });
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');
  const [rows, setRows] = useState<readonly HandoffRow[]>(history);
  const base = `/api/admin/leads/${leadId}`;

  async function refresh() {
    try {
      const r = await fetch(`${base}/handoff`, { cache: 'no-store' });
      const j = (await r.json()) as { ok?: boolean; items?: HandoffRow[] };
      if (j.ok && j.items) setRows(j.items);
    } catch { /* 이력 갱신 실패는 표시만 생략 */ }
  }
  async function open() {
    setMsg('');
    try {
      const r = await fetch(`${base}/packet`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) });
      const j = (await r.json()) as { ok?: boolean; code?: string; packet?: Packet; amendments?: Amendment[]; amendmentsError?: boolean };
      if (j.ok && j.packet) { setPacket(j.packet); setAmend({ items: Array.isArray(j.amendments) ? j.amendments : [], error: j.amendmentsError === true }); await refresh(); } else setMsg(`열람 거부됨: ${String(j.code)}`);
    } catch { setMsg('열람 거부됨: NETWORK'); }
  }
  async function record(event: 'copied' | 'sent') {
    try {
      const r = await fetch(`${base}/handoff`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event === 'sent' ? { event, note } : { event }) });
      const j = (await r.json()) as { ok?: boolean; code?: string };
      if (j.ok) { setMsg(event === 'sent' ? '전달 완료로 기록했습니다.' : '복사 기록을 남겼습니다.'); await refresh(); } else setMsg(`기록 거부됨: ${String(j.code)}`);
    } catch { setMsg('기록 거부됨: NETWORK'); }
  }
  async function copy() {
    if (!packet) return;
    try { await navigator.clipboard.writeText(packet.text); } catch { setMsg('복사에 실패했습니다. 아래 내용을 직접 선택해 복사하세요.'); return; }
    await record('copied');
  }

  return (
    <main className="admin-main" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
      <header className="admin-bar"><span className="brand brand-sm"><span className="brand-mark" aria-hidden="true" />FIDEON 관리 · 총판 전달용 신청서</span><span className="test-badge">로컬 시험 데이터</span></header>
      {packet === null ? (
        <section className="admin-card" aria-label="열람 사유">
          <h2>신청서 열람</h2>
          <p className="muted">개인정보가 복호화되어 표시됩니다(대표만). 열람 사유를 고르면 열람·복사·전달이 이력과 감사 로그에 남으며, 감사 로그에는 개인정보 원문을 저장하지 않습니다.</p>
          <div className="row"><select value={reason} onChange={(e) => setReason(e.target.value)} aria-label="열람 사유">{REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>{' '}
            <button type="button" onClick={open}>신청서 열기</button></div>
        </section>
      ) : (
        <section className="admin-card" aria-label="총판 전달용 신청서">
          <h2>총판 전달용 신청서 <span data-field="status">{STATUS[packet.status]}</span></h2>
          {packet.missingLabels.length > 0 && <p role="alert" data-field="missing">누락 항목: {packet.missingLabels.join(', ')}</p>}
          <pre data-field="packet" style={{ whiteSpace: 'pre-wrap', userSelect: 'text' }}>{packet.text}</pre>
          <section aria-label="변경 요청" data-field="amendments">
            {amend.error ? <p role="alert">변경 요청을 불러오지 못했습니다. 다시 열어 확인하세요(변경 요청이 없다는 뜻이 아님).</p>
              : amend.items.length === 0 ? <p className="muted">고객 변경 요청: 없음</p> : (
              <>
                <p role="alert">고객 변경 요청 {amend.items.length}건 — 위 신청서(원본)는 바뀌지 않았습니다. 총판 전달 전 고객 확인 후 반영하세요.</p>
                {amend.items.map((m, i) => (
                  <div key={`${m.createdAt}-${i}`} data-field="amendment">
                    <p>변경 요청 {i + 1} · {String(m.createdAt).slice(0, 19).replace('T', ' ')} · 변경 항목: {m.changes.length === 0 ? '없음' : m.changes.map((c) => c.label).join(', ')}</p>
                    <ul>{m.changes.map((c) => <li key={c.key} data-key={c.key}>{c.label}: {c.before} → {c.after}</li>)}</ul>
                  </div>
                ))}
              </>
            )}
          </section>
          <p className="muted" data-field="dealer-only">총판 별도 확인: {packet.dealerOnly.map((d) => d.label).join(' · ')} — 질문·저장·AI 전달 모두 하지 않습니다.</p>
          <div className="row"><button type="button" onClick={copy}>복사</button></div>
          <div className="row"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="전달한 총판 이름(필수, 연락처·계좌 입력 금지)" aria-label="전달 메모" maxLength={30} />{' '}
            <button type="button" disabled={note.trim().length < 2 || packet.status !== 'ready'} onClick={() => record('sent')}>총판 전달 완료 기록</button></div>
        </section>
      )}
      <p role="status" data-field="msg">{msg}</p>
      <section aria-label="전달 이력"><h2>전달 이력</h2>
        {rows.length === 0 ? <p data-field="history">이력이 없습니다.</p> : (
          <ul data-field="history">{rows.map((h, i) => <li key={`${h.createdAt}-${i}`}>{EV[h.event] ?? h.event} · {String(h.createdAt).slice(0, 19).replace('T', ' ')}{h.note ? ` · ${h.note}` : ''}</li>)}</ul>
        )}
      </section>
    </main>
  );
}
