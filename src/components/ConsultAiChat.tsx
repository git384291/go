'use client';

import { useState } from 'react';
import { AI_NOTICE } from '../content/consultPreview';
import { resolveAttribution } from '../content/attribution';

// AI 24시간 상담창(PM 11/21 ②). 글을 서버(/api/consult/chat)로만 보낸다. 요금·사은품은 서버가 승인 정책에서 만든 문장만 돌려준다.
// 개인정보는 여기 쓰지 않도록 안내하고(서버도 가림), 신청은 기존 접수 양식(/consult)으로 이어진다. 모델·키·비용 정보는 화면에 없다.
const SAFE = '지금은 자동 안내를 불러오지 못했습니다. 담당자가 확인한 뒤 안내드리겠습니다.';
export type ChatChoice = { carrier: string; productId: string; regionCode: string };
type Msg = { from: 'me' | 'ai'; text: string };

export function ConsultAiChat({ choice }: { choice: ChatChoice }) {
  const [text, setText] = useState('');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  // 서버가 첫 응답에서 내려 주는 서명 세션 토큰(상담 시작 건수 집계용, 개인정보 아님). 브라우저가 직접 만들지 않는다
  const [session, setSession] = useState<string | null>(null);
  const ready = text.trim().length > 0 && text.length <= 300 && !busy;
  async function send() {
    const message = text.trim();
    setBusy(true);
    setMsgs((m) => [...m, { from: 'me', text: message }]);
    setText('');
    let reply = SAFE;
    try {
      const res = await fetch('/api/consult/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...choice, message, ...(session ? { session } : {}), ...campaignOf() }) });
      const j = (await res.json()) as { ok?: boolean; text?: unknown; session?: unknown };
      if (res.ok && j.ok === true && typeof j.text === 'string') reply = j.text;
      if (typeof j.session === 'string' && j.session.length <= 200) setSession(j.session);
    } catch { /* 안전 안내문 유지 */ }
    setMsgs((m) => [...m, { from: 'ai', text: reply }]);
    setBusy(false);
  }
  return (
    <section aria-label="AI 상담" className="admin-card">
      <p className="muted">{AI_NOTICE} 이름·전화번호·주소는 여기에 적지 마세요. 가입 신청은 화면 아래 신청 양식에서 합니다.</p>
      <div role="log" aria-live="polite" style={{ display: 'grid', gap: 8, margin: '12px 0' }}>
        {msgs.map((m, i) => (
          <p key={i} data-from={m.from} style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', textAlign: m.from === 'me' ? 'right' : 'left' }}>
            <strong>{m.from === 'me' ? '나' : 'AI 도우미'}</strong>: {m.text}
          </p>
        ))}
      </div>
      <textarea aria-label="상담 내용" placeholder="궁금한 점을 적어 주세요(300자 이내)" maxLength={300} rows={3} value={text} onChange={(e) => setText(e.target.value)} style={{ width: '100%', boxSizing: 'border-box' }} />
      <p><button type="button" disabled={!ready} onClick={send}>보내기</button> <a href="#apply">가입 상담 신청하기</a></p>
    </section>
  );
}

/** 첫 유입 출처의 캠페인 키(접수 양식과 같은 규칙). 형식이 맞을 때만 보낸다 */
function campaignOf(): { campaign?: string } {
  try {
    const v = resolveAttribution(window.location.search, window.sessionStorage).utmCampaign;
    return typeof v === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(v) ? { campaign: v } : {};
  } catch { return {}; }
}
