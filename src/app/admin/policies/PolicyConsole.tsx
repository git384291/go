'use client';
import { useState } from 'react';

// 정책 업로드(검증·초안 저장)와 제출·승인·반려 조작. 화면은 권한을 정하지 않는다: 버튼 표시는 편의일 뿐이며
// 서버 모듈과 DB 함수가 매번 역할을 다시 판정한다. 승인 시 5개 확인 항목을 모두 체크해야 보낼 수 있다.
const CHECKS: [string, string][] = [
  ['source_matched', '원문(정책표)과 값이 일치함'], ['validity', '유효기간 확인함'], ['vat', '부가세 포함/별도 확인함'],
  ['benefit_terms', '사은품 지급·환수 조건 확인함'], ['region_bundle', '지역·결합 조건 확인함'],
];
const SAMPLE = JSON.stringify({
  supplierId: '', segment: 'household', carrier: '', productId: '', category: 'internet_tv', sourceKind: 'official_policy_sheet',
  confirmedAt: '', validFrom: '', validUntil: '', productLabel: '',
  terms: {
    monthlyFee: { known: false }, contractMonths: { known: false }, equipmentMonthlyFee: { known: false }, installFee: { known: false },
    bundlePrerequisites: { known: false }, regionScope: { known: false }, customerBenefit: { known: false },
  },
}, null, 2);

async function call(url: string, method: 'GET' | 'POST', body?: unknown) {
  try {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return (await r.json()) as Record<string, unknown>;
  } catch { return { ok: false, code: 'NETWORK' }; }
}

export function UploadPanel() {
  const [text, setText] = useState(SAMPLE);
  const [msg, setMsg] = useState<string>('');
  async function run(dryRun: boolean) {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { setMsg('JSON 형식이 올바르지 않습니다.'); return; }
    const res = await call('/api/admin/policies', 'POST', dryRun ? { ...parsed, dryRun: true } : parsed);
    if (res.ok !== true) { setMsg(`거부됨: ${String(res.code)}`); return; }
    const reasons = Array.isArray(res.reasons) ? (res.reasons as string[]) : [];
    setMsg(`${dryRun ? '검증' : '초안 저장'} 완료 — ${res.quotable ? '견적 가능한 정책' : `견적 불가 사유: ${reasons.join(', ')}`}`);
    if (!dryRun) location.reload();
  }
  return (
    <section className="admin-card" aria-label="정책 업로드">
      <h2>정책 업로드</h2>
      <p className="muted">값은 모름(known:false)으로 비워 둘 수 있으나, 모르는 항목이 있으면 승인 후에도 고객 견적은 나가지 않습니다. 수수료·원문 위치는 받지 않습니다.</p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={16} spellCheck={false} aria-label="정책 JSON" style={{ width: '100%', fontFamily: 'monospace' }} />
      <div className="row">
        <button type="button" onClick={() => run(true)}>검증만</button>{' '}
        <button type="button" onClick={() => run(false)}>초안 저장</button>
      </div>
      <p role="status">{msg}</p>
    </section>
  );
}

export function RowActions({ id, state, role }: { id: string; state: string; role: string }) {
  const [reason, setReason] = useState('');
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [msg, setMsg] = useState('');
  const canEdit = role === 'owner' || role === 'policy_editor';
  async function act(action: 'submit' | 'approve' | 'reject') {
    const body = action === 'submit' ? { action } : action === 'reject' ? { action, reason } : { action, reason, checks };
    const res = await call(`/api/admin/policies/${id}`, 'POST', body);
    if (res.ok === true) location.reload(); else setMsg(`거부됨: ${String(res.code)}`);
  }
  if (state === 'draft' && canEdit) return <><button type="button" onClick={() => act('submit')}>검수 요청</button> <span role="status">{msg}</span></>;
  if (state === 'submitted' && role === 'owner') {
    const all = CHECKS.every(([k]) => checks[k] === true);
    return (
      <div>
        {CHECKS.map(([k, label]) => (
          <label key={k} style={{ display: 'block' }}><input type="checkbox" checked={checks[k] === true} onChange={(e) => setChecks({ ...checks, [k]: e.target.checked })} /> {label}</label>
        ))}
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="사유(필수)" aria-label="사유" maxLength={500} />{' '}
        <button type="button" disabled={!all || reason.trim().length < 2} onClick={() => act('approve')}>승인</button>{' '}
        <button type="button" disabled={reason.trim().length < 2} onClick={() => act('reject')}>반려</button>
        <span role="status"> {msg}</span>
      </div>
    );
  }
  return <span className="muted">{state === 'submitted' ? '대표 승인 대기' : '—'}</span>;
}
