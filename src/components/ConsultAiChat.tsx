'use client';

import { useRef, useState } from 'react';
import { AI_NOTICE } from '../content/consultPreview';
import { resolveAttribution } from '../content/attribution';
import { neededFields, nextQuestion, type Application } from '../content/applicationForm';
import { TurnstileWidget, type TurnstileHandle, type TurnstileStatus } from './TurnstileWidget';

// AI 24시간 상담창(PM 11/21 ②). 글을 서버(/api/consult/chat)로만 보낸다. 요금·사은품은 서버가 승인 정책에서 만든 문장만 돌려준다.
// 개인정보는 여기 쓰지 않도록 안내하고(서버도 가림), 신청은 기존 접수 양식(/consult)으로 이어진다. 모델·키·비용 정보는 화면에 없다.
// 상담창에는 연락처가 없으므로 '담당자가 연락' 같은 약속을 하지 않는다. 다시 보내기 또는 신청 양식(대표 직접 연락 동의 포함)으로 안내한다
export const SAFE = '지금은 자동 안내를 불러오지 못했습니다. 잠시 후 다시 보내 주시거나, 아래 가입 상담 신청 양식에 남겨 주세요.';
/** 서버 응답이 이 시간 안에 안 오면(서버 상담 상한 8~10초 + 여유) 기다리기를 멈추고 안전 안내문으로 전환한다. 브라우저는 자동 재시도하지 않는다(재시도는 서버가 상한 안에서만) */
export const CLIENT_TIMEOUT_MS = 13000;
export type ChatChoice = { carrier: string; productId: string; regionCode: string };
type Msg = { from: 'me' | 'ai' | 'assist'; text: string };
const TURNSTILE_SITE_KEY = (process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? '').trim();

/** 신청서 도우미가 이어서 묻는 말(고정 문장·화면 안에서만 만든다, AI 모델·서버로 가지 않는다). 필수 항목 중 빠진 것만 순서대로, 이미 받은 것은 다시 묻지 않는다 */
export function assistFollowUp(app: Application, intakeOpen: boolean): string {
  const q = nextQuestion(app);
  const need = q && neededFields(app).some((f) => f.key === q.key);
  if (!need && !intakeOpen) return '신청서 도우미: 필요한 정보는 모두 채워졌지만, 필수 고지 문구가 확정되기 전이라 접수는 아직 받을 수 없습니다. 접수가 열리면 안내해 드립니다.';
  return need ? `신청서 도우미: ${q.question} (아래 신청서 도우미에 답해 주세요. 주민번호·자동이체·사은품계좌는 묻지 않습니다)` : '신청서 도우미: 신청서에 필요한 정보가 모두 채워졌습니다. 아래 가입 상담 신청에서 접수해 주세요.';
}

// intakeOpen: 필수 고지가 확정돼 접수를 받을 수 있는지(화면 상수 기준). false면 정보가 모두 채워져도 '접수 가능'으로 안내하지 않는다
export function ConsultAiChat({ choice, application, intakeOpen = false }: { choice: ChatChoice; application?: Application; intakeOpen?: boolean }) {
  const [text, setText] = useState('');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  // 상태 갱신 전에 두 번 눌러도 요청이 한 번만 나가도록 막는 동기 잠금
  const sending = useRef(false);
  // 서버가 첫 응답에서 내려 주는 서명 세션 토큰(상담 시작 건수 집계용, 개인정보 아님). 브라우저가 직접 만들지 않는다
  const [session, setSession] = useState<string | null>(null);
  // 새 상담 세션은 서버 측 봇 확인(PM 11/22 F1)을 통과해야 열린다. 토큰은 1회용: 보낸 뒤 비우고 위젯을 다시 받는다
  const botRef = useRef<string | null>(null);
  const [botReady, setBotReady] = useState(false);
  const widget = useRef<TurnstileHandle>(null);
  // 봇 확인이 오류·만료되면 고객에게 안내하고 다시 확인할 수 있게 한다(토큰이 없으면 보내기는 계속 잠김 — 우회 없음)
  const [botStatus, setBotStatus] = useState<TurnstileStatus>('loading');
  const [widgetKey, setWidgetKey] = useState(0);
  const retryBot = () => { if (!widget.current?.reset()) setWidgetKey((k) => k + 1); };
  const appRef = useRef(application);
  appRef.current = application;
  const intakeOpenRef = useRef(intakeOpen);
  intakeOpenRef.current = intakeOpen;
  const ready = text.trim().length > 0 && text.length <= 300 && !busy && (session !== null || botReady);
  async function send() {
    if (sending.current) return;
    sending.current = true;
    const message = text.trim();
    setBusy(true);
    setMsgs((m) => [...m, { from: 'me', text: message }]);
    setText('');
    let reply = SAFE;
    let ask: string | null = null; // 대표 직접 연락 동의 질문(서버가 정한 고정 문구만)
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), CLIENT_TIMEOUT_MS);
    try {
      const res = await fetch('/api/consult/chat', { method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...choice, message, ...(session ? { session } : botRef.current ? { turnstileToken: botRef.current } : {}), ...campaignOf() }) });
      const j = (await res.json()) as { ok?: boolean; text?: unknown; session?: unknown; next?: unknown; callbackPrompt?: unknown };
      if (res.ok && j.ok === true && typeof j.text === 'string') reply = j.text;
      if (res.ok && j.ok === true && j.next === 'callback' && typeof j.callbackPrompt === 'string' && j.callbackPrompt.length <= 200) ask = j.callbackPrompt;
      if (typeof j.session === 'string' && j.session.length <= 200) setSession(j.session);
    } catch { /* 안전 안내문 유지 */ } finally { clearTimeout(timer); }
    if (!session) { botRef.current = null; setBotReady(false); widget.current?.reset(); }
    setMsgs((m) => [...m, { from: 'ai', text: reply }, ...(ask ? [{ from: 'ai' as const, text: ask }] : []), ...(appRef.current ? [{ from: 'assist' as const, text: assistFollowUp(appRef.current, intakeOpenRef.current) }] : [])]);
    setBusy(false);
    sending.current = false;
  }
  return (
    <section aria-label="AI 상담" className="admin-card">
      <p className="muted">{AI_NOTICE} 이름·전화번호·주소는 여기에 적지 마세요. 가입 신청은 화면 아래 신청 양식에서 합니다.</p>
      <div role="log" aria-live="polite" style={{ display: 'grid', gap: 8, margin: '12px 0' }}>
        {msgs.map((m, i) => (
          <p key={i} data-from={m.from} style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', textAlign: m.from === 'me' ? 'right' : 'left' }}>
            <strong>{m.from === 'me' ? '나' : m.from === 'assist' ? '' : 'AI 도우미'}</strong>{m.from === 'assist' ? '' : ': '}{m.text}
          </p>
        ))}
      </div>
      {session === null && TURNSTILE_SITE_KEY !== '' ? (
        <TurnstileWidget key={widgetKey} ref={widget} siteKey={TURNSTILE_SITE_KEY} onToken={(t) => { botRef.current = t; setBotReady(t !== null); }} onStatus={setBotStatus} />
      ) : null}
      {session === null && TURNSTILE_SITE_KEY !== '' && (botStatus === 'error' || botStatus === 'expired') ? (
        <p role="alert" data-bot-status={botStatus}>{botStatus === 'expired' ? '자동 확인 시간이 지났습니다.' : '자동 확인 중 오류가 발생했습니다.'} 아래 다시 확인 버튼을 눌러 주세요. 계속 안 되면 페이지를 새로고침하거나 신청 양식으로 문의해 주세요. <button type="button" onClick={retryBot}>다시 확인</button></p>
      ) : null}
      {session === null && TURNSTILE_SITE_KEY === '' ? <p className="muted" role="status">자동 확인을 준비 중이라 지금은 상담을 시작할 수 없습니다.</p> : null}
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
