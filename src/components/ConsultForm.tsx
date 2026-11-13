'use client';

import { useState, type FormEvent } from 'react';
import { KAKAO_CHANNEL_URL } from '@/content/products';

// REV-004: 실제 고객정보 수집은 재검수 통과 전까지 비활성. 화면만 제공한다.
const FORM_ENABLED = process.env.NEXT_PUBLIC_LEAD_FORM_ENABLED === 'true';
const PRIVACY_VERSION = process.env.NEXT_PUBLIC_PRIVACY_POLICY_VERSION ?? '';

const INTEREST_OPTIONS = [
  { value: 'internet_tv', label: '인터넷 + TV' },
  { value: 'internet_phone', label: '인터넷 + 집전화' },
  { value: 'internet_only', label: '인터넷만' },
  { value: 'cctv_security', label: 'CCTV · 보안' },
  { value: 'other', label: '잘 모르겠어요' },
];

export function ConsultForm({ defaultInterest = 'internet_tv' }: { defaultInterest?: string }) {
  const [consent, setConsent] = useState(false);
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!FORM_ENABLED || !consent) return;
    const f = new FormData(e.currentTarget);
    setState('sending');
    const res = await fetch('/api/leads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: f.get('name'),
        phone: f.get('phone'),
        interest: f.get('interest'),
        contactTime: f.get('contactTime') || undefined,
        consentCollection: consent,
        marketingOptIn: f.get('marketing') === 'on',
        privacyVersion: PRIVACY_VERSION,
        idempotencyKey: crypto.randomUUID(),
        turnstileToken: f.get('cf-turnstile-response'),
      }),
    }).catch(() => null);
    if (res && res.status === 202) {
      setState('done');
      setMessage('신청이 접수되었습니다. 남겨 주신 시간에 연락드릴게요.');
    } else {
      setState('error');
      setMessage('지금은 신청을 받을 수 없습니다. 카카오톡으로 문의해 주세요.');
    }
  }

  return (
    <form className="consult-form" onSubmit={onSubmit} noValidate>
      {!FORM_ENABLED && (
        <div className="form-banner" role="status">
          <strong>온라인 신청 준비 중</strong>
          <span>지금은 카카오톡으로 상담을 도와드려요. 아래 양식은 미리보기이며 입력 내용은 전송되지 않습니다.</span>
          <a className="btn btn-kakao" href={KAKAO_CHANNEL_URL}>카카오톡으로 상담하기</a>
        </div>
      )}

      <fieldset disabled={!FORM_ENABLED || state === 'sending'}>
        <label className="field">
          <span>이름</span>
          <input name="name" autoComplete="name" maxLength={20} placeholder="홍길동" required />
        </label>
        <label className="field">
          <span>휴대폰 번호</span>
          <input name="phone" type="tel" inputMode="numeric" autoComplete="tel" maxLength={13} placeholder="010-0000-0000" required />
        </label>
        <label className="field">
          <span>관심 상품</span>
          <select name="interest" defaultValue={defaultInterest}>
            {INTEREST_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>연락 받기 좋은 시간 <em>(선택)</em></span>
          <input name="contactTime" maxLength={50} placeholder="예: 평일 저녁 7시 이후" />
        </label>

        <div className="consent-box">
          <label className="check">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span><b>[필수]</b> 상담을 위한 개인정보 수집·이용에 동의합니다.</span>
          </label>
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

        <button className="btn btn-primary btn-block" type="submit" disabled={!consent}>
          {state === 'sending' ? '보내는 중…' : '상담 신청하기'}
        </button>
      </fieldset>

      {message && (
        <p className={`form-result ${state}`} role="status">{message}</p>
      )}
    </form>
  );
}
