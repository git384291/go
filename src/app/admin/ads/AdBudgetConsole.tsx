'use client';
import { useState } from 'react';

// 광고 예산 승인·철회·모의 지출 판정. 버튼 표시는 편의일 뿐이며 서버와 DB가 매번 대표 권한을 다시 판정한다.
// 실제 광고 집행은 연결되어 있지 않다: '지출 판정'은 한도 안인지 기록하고 알려줄 뿐이다.
async function call(method: 'POST', body: unknown) {
  try {
    const r = await fetch('/api/admin/ads/budget', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return (await r.json()) as Record<string, unknown>;
  } catch { return { ok: false, code: 'NETWORK' }; }
}
const num = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN);

export function ApprovePanel({ dailyMax, totalMax }: { dailyMax: number; totalMax: number }) {
  const [f, setF] = useState({ campaign: '', daily: '', total: '', hours: '24', reason: '' });
  const [msg, setMsg] = useState('');
  const valid = /^[a-z0-9][a-z0-9_-]{0,63}$/.test(f.campaign) && num(f.daily) >= 1 && num(f.daily) <= dailyMax && num(f.total) >= num(f.daily) && num(f.total) <= totalMax
    && num(f.hours) >= 1 && num(f.hours) <= 72 && f.reason.trim().length >= 2;
  async function submit() {
    const res = await call('POST', { action: 'approve', campaign: f.campaign, dailyCapKrw: num(f.daily), totalCapKrw: num(f.total), hours: num(f.hours), reason: f.reason });
    if (res.ok === true) location.reload(); else setMsg(`거부됨: ${String(res.code)}`);
  }
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <section className="admin-card" aria-label="예산 승인">
      <h2>예산 승인</h2>
      <p className="muted">승인이 없으면 어떤 지출도 허용되지 않습니다. 일 한도 최대 {dailyMax.toLocaleString('ko-KR')}원, 총 한도 최대 {totalMax.toLocaleString('ko-KR')}원, 기간 최대 72시간.</p>
      <div className="row">
        <input aria-label="캠페인 키" placeholder="캠페인 키(영소문자·숫자·-_)" value={f.campaign} onChange={set('campaign')} maxLength={64} />{' '}
        <input aria-label="일 한도(원)" placeholder="일 한도(원)" inputMode="numeric" value={f.daily} onChange={set('daily')} />{' '}
        <input aria-label="총 한도(원)" placeholder="총 한도(원)" inputMode="numeric" value={f.total} onChange={set('total')} />{' '}
        <input aria-label="유효 시간" placeholder="유효 시간(1~72)" inputMode="numeric" value={f.hours} onChange={set('hours')} />{' '}
        <input aria-label="승인 사유" placeholder="승인 사유(필수)" value={f.reason} onChange={set('reason')} maxLength={500} />{' '}
        <button type="button" disabled={!valid} onClick={submit}>승인</button>
      </div>
      <p role="status">{msg}</p>
    </section>
  );
}

export function RevokeButton({ campaign }: { campaign: string }) {
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState('');
  async function go() {
    const res = await call('POST', { action: 'revoke', campaign, reason });
    if (res.ok === true) location.reload(); else setMsg(`거부됨: ${String(res.code)}`);
  }
  return (
    <div>
      <input aria-label="철회 사유" placeholder="철회 사유" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />{' '}
      <button type="button" disabled={reason.trim().length < 2} onClick={go}>철회</button> <span role="status">{msg}</span>
    </div>
  );
}

export function SpendCheckPanel() {
  const [campaign, setCampaign] = useState('');
  const [amount, setAmount] = useState('');
  const [msg, setMsg] = useState('');
  async function go() {
    // randomUUID는 보안 연결에서만 있어 getRandomValues로 대체(요청 키는 매 판정마다 고유해야 한다).
    const c = globalThis.crypto;
    const requestKey = c?.randomUUID ? c.randomUUID() : Array.from(c.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    const res = await call('POST', { action: 'request', campaign, amountKrw: num(amount), requestKey });
    setMsg(res.decision === 'ALLOW' ? '허용됨(한도 안, 원장 기록)' : `차단됨: ${String(res.reason ?? res.code)}`);
  }
  const ok = /^[a-z0-9][a-z0-9_-]{0,63}$/.test(campaign) && num(amount) >= 1;
  return (
    <section className="admin-card" aria-label="지출 판정 시험">
      <h2>지출 판정 시험</h2>
      <p className="muted">한도 안인지 판정하고 기록만 합니다. 실제 광고 집행은 연결되어 있지 않습니다.</p>
      <div className="row">
        <input aria-label="캠페인 키(판정)" placeholder="캠페인 키" value={campaign} onChange={(e) => setCampaign(e.target.value)} />{' '}
        <input aria-label="금액(원)" placeholder="금액(원)" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />{' '}
        <button type="button" disabled={!ok} onClick={go}>판정</button>
      </div>
      <p role="status">{msg}</p>
    </section>
  );
}
