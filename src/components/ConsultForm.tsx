'use client';

import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import {
  classifyResponse,
  firstErrorField,
  IdempotencyKeeper,
  NETWORK_FAILURE,
  OUTCOME_MESSAGES,
  readResponseBody,
  submissionFingerprint,
  SUBMIT_TIMEOUT_MS,
  validateConsultInput,
  type ConsultField,
  type ConsultInput,
  type FieldErrors,
  type SubmitOutcome,
} from './consultSubmit';
import { TurnstileWidget, type TurnstileHandle, type TurnstileStatus } from './TurnstileWidget';

// REV-004: 실제 고객정보 수집은 재검수 통과 전까지 비활성. 화면만 제공한다.
const FORM_ENABLED = process.env.NEXT_PUBLIC_LEAD_FORM_ENABLED === 'true';
const PRIVACY_VERSION = (process.env.NEXT_PUBLIC_PRIVACY_POLICY_VERSION ?? '').trim();
// 공개 사이트 키(비밀 아님). 비어 있으면 위젯·스크립트를 만들지 않고 전송하지 않는다(기본 비어 있음).
const TURNSTILE_SITE_KEY = (process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? '').trim();

// PHASE 1: 이 파일은 브라우저로 내려가는 코드다. 예약 상품의 이름·값을 여기에 두지 않는다.
// 선택지는 서버(상담 페이지)가 활성 상품만 골라 넘긴다. 예약 상품을 포함한 전체 선택지는
// src/content/catalog.ts(서버 쪽)에 그대로 보존되어 있다.
export type ConsultOption = { value: string; label: string };

type Phase = 'idle' | 'sending' | 'done' | 'error';

// 요청 키: 보안 컨텍스트가 아니어서 randomUUID가 없어도 안전한 난수로 만든다(32자 16진수, 서버 형식 16~64자 이내)
const newKey = (): string => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
};

// kakaoUrl: 외부 상담 채널 주소. 서버가 채널을 열지 않으면 null을 넘긴다(PHASE 1 보완: 현재 null).
export function ConsultForm({ options, kakaoUrl }: { options: readonly ConsultOption[]; kakaoUrl: string | null }) {
  const hasOption = options.length > 0;
  // 공개 준비값(사이트 키·처리방침 버전)이 하나라도 비면 위젯 외부 요청과 접수 요청을 모두 만들지 않는다
  const botEnabled = FORM_ENABLED && hasOption && TURNSTILE_SITE_KEY !== '' && PRIVACY_VERSION !== '';
  const [consent, setConsent] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [botStatus, setBotStatus] = useState<TurnstileStatus>('loading');
  // 위젯 재마운트 번호: 초기 로딩·render 실패나 SDK reset 실패 때 바꿔 스크립트부터 다시 시도한다
  const [widgetMount, setWidgetMount] = useState(0);

  // 동기 잠금: 상태 반영(재렌더) 전에 들어오는 빠른 이중 클릭·Enter 재제출을 막는다
  const inFlight = useRef(false);
  const accepted = useRef(false);
  // 고객 입력·요청 키·봇 토큰은 이 컴포넌트 메모리에만 둔다
  const keeper = useRef<IdempotencyKeeper | null>(null);
  const botToken = useRef<string | null>(null);
  const widget = useRef<TurnstileHandle>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const consentRef = useRef<HTMLInputElement>(null);
  const fieldRefs = { name: nameRef, phone: phoneRef, consent: consentRef } satisfies Record<ConsultField, RefObject<HTMLInputElement | null>>;

  // 첫 오류 초점은 화면 반영(잠금 해제) 뒤에 옮긴다. 같은 칸에 연달아 오류가 나도 다시 옮기도록 순번을 둔다
  const [focusReq, setFocusReq] = useState<{ field: ConsultField; seq: number } | null>(null);
  function focusField(f: ConsultField | null) {
    if (f) setFocusReq((prev) => ({ field: f, seq: (prev?.seq ?? 0) + 1 }));
  }
  useEffect(() => {
    if (!focusReq) return;
    const target = focusReq.field === 'name' ? nameRef : focusReq.field === 'phone' ? phoneRef : consentRef;
    target.current?.focus();
  }, [focusReq]);

  function clearFieldError(f: ConsultField) {
    setErrors((prev) => {
      if (prev[f] === undefined) return prev;
      const next = { ...prev };
      delete next[f];
      return next;
    });
  }

  function finish(result: SubmitOutcome) {
    if (result.kind === 'accepted') {
      accepted.current = true;
      setPhase('done');
      setMessage(result.message);
      return;
    }
    setPhase('error');
    if (result.kind === 'field' && result.field) {
      setErrors({ [result.field]: result.message });
      setMessage(OUTCOME_MESSAGES.input);
      focusField(result.field);
    } else {
      setMessage(kakaoUrl && result.kind === 'not_ready' ? `${result.message} 카카오톡으로 문의해 주세요.` : result.message);
    }
  }

  /** 새 봇 토큰 받기. 그려진 위젯은 reset, 실패·미완료 위젯은 재마운트. 예외를 밖으로 내보내지 않는다 */
  function refreshBot() {
    botToken.current = null;
    let ok = false;
    try {
      ok = widget.current?.reset() ?? false;
    } catch {
      ok = false;
    }
    if (!ok) {
      setBotStatus('loading');
      setWidgetMount((n) => n + 1);
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (inFlight.current || accepted.current) return;
    if (!FORM_ENABLED || !hasOption) return;
    inFlight.current = true;
    try {
      const f = new FormData(e.currentTarget);
      const input: ConsultInput = {
        name: String(f.get('name') ?? ''),
        phone: String(f.get('phone') ?? ''),
        interest: String(f.get('interest') ?? ''),
        contactTime: String(f.get('contactTime') ?? ''),
        consent,
        marketing: f.get('marketing') === 'on',
      };

      const fieldErrors = validateConsultInput(input);
      setErrors(fieldErrors);
      const first = firstErrorField(fieldErrors);
      if (first) {
        setPhase('error');
        setMessage(OUTCOME_MESSAGES.input);
        focusField(first);
        return;
      }
      if (!botEnabled) {
        // 공개 사이트 키가 없으면 서버가 어차피 거부한다. 보내지 않는다
        setPhase('error');
        setMessage(OUTCOME_MESSAGES.not_ready);
        return;
      }
      const token = botToken.current;
      if (!token) {
        setPhase('error');
        setMessage(botStatus === 'expired' || botStatus === 'error' ? OUTCOME_MESSAGES.bot : OUTCOME_MESSAGES.bot_pending);
        return;
      }

      keeper.current ??= new IdempotencyKeeper(newKey);
      const idempotencyKey = keeper.current.keyFor(submissionFingerprint(input, PRIVACY_VERSION));
      // 봇 토큰은 일회용: 보내는 순간 비우고, 결과와 상관없이 접수 실패면 새 토큰을 받는다
      botToken.current = null;
      setPhase('sending');
      setMessage('');

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), SUBMIT_TIMEOUT_MS);
      let result: SubmitOutcome;
      try {
        const res = await fetch('/api/leads', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          cache: 'no-store',
          signal: ctrl.signal,
          body: JSON.stringify({
            name: input.name.trim(),
            phone: input.phone.trim(),
            interest: input.interest,
            contactTime: input.contactTime.trim() || undefined,
            consentCollection: input.consent,
            marketingOptIn: input.marketing,
            privacyVersion: PRIVACY_VERSION,
            idempotencyKey,
            turnstileToken: token,
          }),
        });
        result = classifyResponse(res.status, await readResponseBody(res));
      } catch {
        result = NETWORK_FAILURE; // 응답 유실·시간 초과: 같은 내용이면 같은 키로 다시 보낼 수 있다
      } finally {
        clearTimeout(timer);
      }
      // 폼 상태부터 정리한다(위젯 SDK가 실패해도 잠금이 남지 않게)
      finish(result);
      if (result.kind !== 'accepted') refreshBot();
    } finally {
      inFlight.current = false;
    }
  }

  const locked = !FORM_ENABLED || phase === 'sending' || phase === 'done';
  const errId = (f: ConsultField) => `consult-err-${f}`;

  return (
    <form className="consult-form" onSubmit={onSubmit} noValidate aria-busy={phase === 'sending'}>
      {!FORM_ENABLED && (
        <div className="form-banner" role="status">
          <strong>온라인 상담 서비스 준비 중</strong>
          {kakaoUrl ? (
            <>
              <span>지금은 카카오톡으로 상담을 도와드려요. 아래 양식은 미리보기이며 입력 내용은 전송되지 않습니다.</span>
              <a className="btn btn-kakao" href={kakaoUrl}>카카오톡으로 상담하기</a>
            </>
          ) : (
            <span>지금은 상담 신청을 받지 않습니다. 아래 양식은 미리보기이며 입력 내용은 전송되지 않습니다.</span>
          )}
        </div>
      )}

      <fieldset disabled={locked}>
        <label className="field">
          <span>이름</span>
          <input
            ref={fieldRefs.name}
            name="name"
            autoComplete="name"
            maxLength={20}
            placeholder="홍길동"
            required
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={errors.name ? errId('name') : undefined}
            onChange={() => clearFieldError('name')}
          />
          {errors.name && <span id={errId('name')} className="field-error">{errors.name}</span>}
        </label>
        <label className="field">
          <span>휴대폰 번호</span>
          <input
            ref={fieldRefs.phone}
            name="phone"
            type="tel"
            inputMode="numeric"
            autoComplete="tel"
            maxLength={13}
            placeholder="010-0000-0000"
            required
            aria-invalid={errors.phone ? true : undefined}
            aria-describedby={errors.phone ? errId('phone') : undefined}
            onChange={() => clearFieldError('phone')}
          />
          {errors.phone && <span id={errId('phone')} className="field-error">{errors.phone}</span>}
        </label>
        {options.length > 1 ? (
          <label className="field">
            <span>관심 상품</span>
            <select name="interest" defaultValue={options[0].value}>
              {options.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
        ) : hasOption ? (
          <div className="field">
            <span>상담 상품</span>
            <p className="field-fixed">{options[0].label}</p>
            <input type="hidden" name="interest" value={options[0].value} />
          </div>
        ) : null}
        <label className="field">
          <span>연락 받기 좋은 시간 <em>(선택)</em></span>
          <input name="contactTime" maxLength={50} placeholder="예: 평일 저녁 7시 이후" />
        </label>

        <div className="consent-box">
          <label className="check">
            <input
              ref={fieldRefs.consent}
              type="checkbox"
              checked={consent}
              aria-invalid={errors.consent ? true : undefined}
              aria-describedby={errors.consent ? errId('consent') : undefined}
              onChange={(e) => {
                setConsent(e.target.checked);
                clearFieldError('consent');
              }}
            />
            <span><b>[필수]</b> 상담을 위한 개인정보 수집·이용에 동의합니다.</span>
          </label>
          {errors.consent && <span id={errId('consent')} className="field-error">{errors.consent}</span>}
          <details>
            <summary>수집 항목과 보유 기간 보기</summary>
            <p>수집 항목: 이름, 휴대폰 번호, 관심 상품, 연락 희망 시간</p>
            <p>이용 목적: 가입 상담 연락</p>
            <p>보유 기간: 처리방침 확정 후 게시(확정 전에는 신청을 받지 않습니다)</p>
            <p>주소 등 가입에 필요한 정보는 상담 후 가입을 원하실 때만 따로 받습니다.</p>
          </details>
          <label className="check">
            <input type="checkbox" name="marketing" />
            <span><b>[선택]</b> 요금 혜택 등 광고성 정보를 문자로 받겠습니다.</span>
          </label>
        </div>

        {botEnabled && phase !== 'done' && (
          <TurnstileWidget
            key={widgetMount}
            ref={widget}
            siteKey={TURNSTILE_SITE_KEY}
            onToken={(t) => {
              botToken.current = t;
            }}
            onStatus={setBotStatus}
          />
        )}
        {botEnabled && phase !== 'done' && (botStatus === 'expired' || botStatus === 'error') && (
          <div className="bot-recover" role="status">
            <p className="field-hint">
              {botStatus === 'expired' ? '자동 입력 방지 확인 시간이 지났습니다.' : '자동 입력 방지 확인을 불러오지 못했습니다.'}
            </p>
            <button type="button" className="btn btn-block" onClick={refreshBot}>자동 입력 방지 다시 확인</button>
          </div>
        )}

        <button className="btn btn-primary btn-block" type="submit" disabled={!hasOption}>
          {!FORM_ENABLED ? '온라인 상담 서비스 준비 중' : phase === 'sending' ? '보내는 중…' : phase === 'done' ? '접수 완료' : '상담 신청하기'}
        </button>
      </fieldset>

      {message && (
        <p className={`form-result ${phase}`} role={phase === 'error' ? 'alert' : 'status'}>{message}</p>
      )}
    </form>
  );
}
