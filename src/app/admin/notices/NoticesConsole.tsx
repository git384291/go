'use client';
import { useState } from 'react';
import { verifyNoticeSource, type NoticeTextRow } from '../../../content/requiredNotices';

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

const LABEL: Record<string, string> = {
  MATCH: '일치', WHITESPACE_ONLY: '공백·줄바꿈만 다름(정리 후 다시 입력 필요)', DIFF: '내용이 다름', KEY_MISSING_IN_DB: 'DB에 이 항목이 없음', SOURCE_MISSING: '대조할 원문 없음',
};
// 총판 고지 원문 ↔ 저장 문구 대조(대표·검토자). 브라우저 안에서만 비교한다 — 서버로 보내지 않고 아무것도 저장·변경하지 않는다.
export function SourceCheckPanel({ rows }: { rows: readonly NoticeTextRow[] }) {
  const [f, setF] = useState({ version: '', key: '', source: '' });
  const [out, setOut] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => { setF({ ...f, [k]: e.target.value }); setOut(null); };
  function run() {
    const r = verifyNoticeSource(f.version.trim(), rows, { [f.key.trim()]: f.source })[0];
    setOut(r ? `${LABEL[r.result] ?? r.result}${r.diffAt !== null ? ` (첫 차이: ${r.diffAt + 1}번째 글자)` : ''}` : '결과 없음');
  }
  const ok = f.version.trim() !== '' && f.key.trim() !== '' && f.source.trim() !== '';
  return (
    <section className="admin-card" aria-label="원문 대조">
      <h2>총판 고지 원문 대조</h2>
      <p className="muted">총판이 준 원문을 붙여 넣으면 저장된 문구와 글자 단위로 비교합니다. 비교만 하며 저장·접수 개방과 무관합니다.</p>
      <div className="row"><input value={f.version} onChange={set('version')} placeholder="버전" aria-label="대조 버전" maxLength={64} />{' '}
        <input value={f.key} onChange={set('key')} placeholder="항목 키" aria-label="대조 항목 키" maxLength={40} /></div>
      <textarea value={f.source} onChange={set('source')} rows={5} maxLength={4000} aria-label="총판 원문" placeholder="총판 고지 원문을 그대로 붙여 넣기" style={{ width: '100%' }} />
      <div className="row"><button type="button" disabled={!ok} onClick={run}>대조</button></div>
      <p role="status" data-field="source-result">{out ?? ''}</p>
    </section>
  );
}

const CHECKS: readonly (readonly [string, string])[] = [
  ['source_matched', '총판 원문과 저장된 문구가 일치함(원문 대조 확인)'],
  ['version_matched', '고지 버전이 처리방침 버전과 같음'],
  ['keys_complete', '필수 항목(키)이 빠짐없이 있음'],
  ['conditions_checked', '총판의 적용 조건(대상·기간·동의 방식 등)을 원문과 대조함'],
  ['screen_checked', '고객 화면에 표시되는 모습을 확인함'],
];
// 총판 고지 조건 검수 기록(대표·검토자). 승인은 5개를 모두 확인해야 눌린다. 같은 버전의 문구를 직접 입력한 사람은 서버가 승인을 거절한다.
// 승인해도 접수는 열리지 않는다(코드 상수 확정은 별도 승인·배포).
export function ReviewPanel() {
  const [version, setVersion] = useState('');
  const [reason, setReason] = useState('');
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [msg, setMsg] = useState('');
  const all = CHECKS.every(([k]) => checks[k] === true);
  const base = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version) && reason.trim().length >= 2;
  async function send(decision: 'approved' | 'rejected') {
    const body = { version, decision, checks: Object.fromEntries(CHECKS.map(([k]) => [k, checks[k] === true])), reason };
    try {
      const r = await fetch('/api/admin/notices/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = (await r.json()) as { ok?: boolean; code?: string };
      if (j.ok === true) location.reload(); else setMsg(`거부됨: ${String(j.code)}`);
    } catch { setMsg('거부됨: NETWORK'); }
  }
  return (
    <section className="admin-card" aria-label="고지 검수">
      <h2>총판 고지 조건 검수</h2>
      <p className="muted">버전별로 확인 항목을 모두 확인한 뒤 승인합니다. 문구를 직접 입력한 사람은 같은 버전을 승인할 수 없고, 문구가 더 추가되면 이전 승인은 최신이 아닙니다. 승인해도 접수는 열리지 않습니다.</p>
      <div className="row"><input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="검수할 버전" aria-label="검수 버전" maxLength={64} /></div>
      {CHECKS.map(([k, label]) => (
        <label key={k} className="check"><input type="checkbox" checked={checks[k] === true} onChange={(e) => setChecks({ ...checks, [k]: e.target.checked })} /><span>{label}</span></label>
      ))}
      <div className="row"><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="검수 사유(필수)" aria-label="검수 사유" maxLength={500} />{' '}
        <button type="button" disabled={!base || !all} onClick={() => send('approved')}>검수 승인</button>{' '}
        <button type="button" disabled={!base} onClick={() => send('rejected')}>검수 반려</button></div>
      <p role="status" data-field="review-result">{msg}</p>
    </section>
  );
}
