'use client';
import { useState } from 'react';

// 모의 광고 플랫폼 집행 요청·성과 수집. 버튼은 편의일 뿐, 승인·한도·권한은 서버와 DB가 매번 다시 판정한다. 실제 집행·과금 없음.
async function post(body: unknown) {
  try {
    const r = await fetch('/api/admin/ads/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return (await r.json()) as Record<string, unknown>;
  } catch { return { ok: false, code: 'NETWORK' }; }
}
const num = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN);
const CAMPAIGN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function FunnelConsole() {
  const [camp, setCamp] = useState('');
  const [amount, setAmount] = useState('');
  const [day, setDay] = useState('');
  const [launchMsg, setLaunchMsg] = useState('');
  const [collectMsg, setCollectMsg] = useState('');
  const okLaunch = CAMPAIGN.test(camp) && num(amount) >= 1 && num(amount) <= 10000;
  const okCollect = CAMPAIGN.test(camp) && /^\d{4}-\d{2}-\d{2}$/.test(day);
  async function launch() {
    const c = globalThis.crypto;
    const requestKey = c?.randomUUID ? c.randomUUID() : Array.from(c.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    const r = await post({ action: 'launch', campaign: camp, amountKrw: num(amount), requestKey });
    setLaunchMsg(r.ok === true ? `허용됨(모의 집행, 실제 집행 없음${r.executed === true ? '·실행됨' : ''})` : `차단됨: ${String(r.reason ?? r.code)}`);
  }
  async function collect() {
    const r = await post({ action: 'collect', campaign: camp, day });
    if (r.ok === true) setCollectMsg(r.recorded === true ? `수집됨${r.overLedger === true ? '(승인 원장보다 큼: 점검 필요)' : ''}` : '이미 수집된 날짜입니다');
    else setCollectMsg(`거부됨: ${String(r.code)}`);
  }
  return (
    <section className="admin-card" aria-label="모의 집행·수집">
      <h2>모의 집행·성과 수집</h2>
      <p className="muted">승인된 예산 안에서만 모의 집행이 허용됩니다. 실제 광고 플랫폼에는 연결되어 있지 않습니다.</p>
      <p>
        <input aria-label="캠페인 키(집행)" placeholder="캠페인 키" value={camp} onChange={(e) => setCamp(e.target.value)} />{' '}
        <input aria-label="집행 금액(원)" placeholder="금액(원)" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />{' '}
        <button type="button" disabled={!okLaunch} onClick={launch}>모의 집행 요청</button>
      </p>
      <p role="status" aria-label="집행 결과">{launchMsg}</p>
      <p>
        <input aria-label="수집 날짜" placeholder="YYYY-MM-DD" value={day} onChange={(e) => setDay(e.target.value)} />{' '}
        <button type="button" disabled={!okCollect} onClick={collect}>성과 수집</button>
      </p>
      <p role="status" aria-label="수집 결과">{collectMsg}</p>
    </section>
  );
}
