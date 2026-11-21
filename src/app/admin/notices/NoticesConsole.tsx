'use client';
import { useState } from 'react';

// 필수 고지 문구 한 항목 입력(대표). 화면은 권한을 정하지 못한다: 서버 모듈과 DB 함수가 매번 대표 여부를 다시 판정한다.
// 문구 입력란은 비어 있다 — 임의 문구를 채워 두지 않는다.
export function NoticeAddPanel() {
  const [f, setF] = useState({ version: '', key: '', body: '', reason: '' });
  const [msg, setMsg] = useState('');
  const ok = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(f.version) && /^[a-z][a-z0-9_]{0,39}$/.test(f.key) && f.body.trim().length > 0 && f.reason.trim().length >= 2;
  async function save() {
    try {
      const r = await fetch('/api/admin/notices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f) });
      const j = (await r.json()) as { ok?: boolean; code?: string };
      if (j.ok === true) location.reload(); else setMsg(`거부됨: ${String(j.code)}`);
    } catch { setMsg('거부됨: NETWORK'); }
  }
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <section className="admin-card" aria-label="고지 문구 입력">
      <h2>고지 문구 입력(한 항목씩)</h2>
      <p className="muted">버전과 항목 키가 같은 문구는 다시 입력할 수 없습니다. 입력해도 접수는 열리지 않습니다.</p>
      <div className="row"><input value={f.version} onChange={set('version')} placeholder="버전(예: 영문·숫자·.-_)" aria-label="고지 버전" maxLength={64} />{' '}
        <input value={f.key} onChange={set('key')} placeholder="항목 키(소문자·숫자·_)" aria-label="항목 키" maxLength={40} /></div>
      <textarea value={f.body} onChange={set('body')} rows={5} maxLength={2000} aria-label="고지 문구" placeholder="확정된 실제 문구를 그대로 입력" style={{ width: '100%' }} />
      <div className="row"><input value={f.reason} onChange={set('reason')} placeholder="입력 사유(필수)" aria-label="입력 사유" maxLength={500} />{' '}
        <button type="button" disabled={!ok} onClick={save}>저장</button></div>
      <p role="status">{msg}</p>
    </section>
  );
}
