'use client';
import { useState } from 'react';

// AI 월 한도 설정. 상한 표시·입력 잠금은 편의일 뿐이며 서버와 DB가 권한(대표)·범위·사유를 매번 다시 판정한다.
const num = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN);

export function AiBudgetConsole({ max, current }: { max: number; current: number }) {
  const [limit, setLimit] = useState(String(current));
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState('');
  const ok = num(limit) >= 0 && num(limit) <= max && reason.trim().length >= 2;
  async function save() {
    let res: Record<string, unknown>;
    try {
      const r = await fetch('/api/admin/ai/budget', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limitKrw: num(limit), reason }) });
      res = (await r.json()) as Record<string, unknown>;
    } catch { res = { ok: false, code: 'NETWORK' }; }
    if (res.ok === true) location.reload(); else setMsg(`거부됨: ${String(res.code)}`);
  }
  return (
    <section className="admin-card" aria-label="월 한도 설정">
      <h2>월 한도 설정</h2>
      <p className="muted">0 ~ {max.toLocaleString('ko-KR')}원. 변경 전후 값과 사유가 감사 기록에 남습니다.</p>
      <p>
        <input aria-label="월 한도(원)" inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value)} />{' '}
        <input aria-label="변경 사유" placeholder="변경 사유(필수)" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />{' '}
        <button type="button" disabled={!ok} onClick={save}>저장</button>
      </p>
      <p role="status">{msg}</p>
    </section>
  );
}
