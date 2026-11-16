'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

// Cloudflare Turnstile 위젯(명시적 렌더). 폼이 켜져 있고 공개 준비값(사이트 키·처리방침 버전)이 모두 있을 때만
// 부모가 이 컴포넌트를 그린다. 그려지지 않으면 스크립트·iframe·외부 요청이 하나도 생기지 않는다.
// - action은 서버 검증(verifyTurnstile)과 같은 'lead_form'으로 고정한다.
// - 봇 토큰은 일회용이다. 부모가 서버 응답을 받은 뒤 reset()으로 새 토큰을 받는다. 사업 요청 키와 섞지 않는다.
// - SDK 호출(render·reset·remove)은 예외를 밖으로 내보내지 않는다. 실패는 'error' 상태로만 알린다.
// - 초기 로딩·render 실패는 reset으로 대신하지 않는다. 부모가 key를 바꿔 다시 마운트하면 스크립트부터 다시 시도한다.
// - 토큰은 부모 메모리로만 넘긴다(저장소·URL·로그 없음).

export const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
export const TURNSTILE_ACTION = 'lead_form';
export const TURNSTILE_LOAD_TIMEOUT_MS = 20000;
const SCRIPT_ATTR = 'data-fideon-turnstile';

type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string | undefined;
  reset: (id: string) => void;
  remove: (id: string) => void;
};
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export type TurnstileStatus = 'loading' | 'ready' | 'expired' | 'error';
/** reset(): 이미 그려진 위젯을 다시 확인한다. 위젯이 없거나 SDK가 실패하면 false(부모가 재마운트해야 함) */
export type TurnstileHandle = { reset: () => boolean };

let scriptPromise: Promise<TurnstileApi> | null = null;

/** 스크립트는 페이지당 한 번만 넣는다. 실패하면 실패한 태그를 지우고 다음 시도에서 새로 넣는다(중복 삽입 없음) */
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (scriptPromise) return scriptPromise;
  const p = new Promise<TurnstileApi>((resolve, reject) => {
    document.querySelectorAll(`script[${SCRIPT_ATTR}]`).forEach((el) => el.remove());
    const s = document.createElement('script');
    s.src = TURNSTILE_SCRIPT_URL;
    s.async = true;
    s.setAttribute(SCRIPT_ATTR, '1');
    const timer = setTimeout(() => reject(new Error('turnstile_load_timeout')), TURNSTILE_LOAD_TIMEOUT_MS);
    s.onload = () => {
      clearTimeout(timer);
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error('turnstile_unavailable'));
    };
    s.onerror = () => {
      clearTimeout(timer);
      reject(new Error('turnstile_load_failed'));
    };
    document.head.appendChild(s);
  });
  scriptPromise = p;
  p.catch(() => {
    if (scriptPromise === p) scriptPromise = null; // 다음 마운트에서 다시 시도
    document.querySelectorAll(`script[${SCRIPT_ATTR}]`).forEach((el) => el.remove());
  });
  return p;
}

type Props = {
  siteKey: string;
  onToken: (token: string | null) => void;
  onStatus: (status: TurnstileStatus) => void;
};

export const TurnstileWidget = forwardRef<TurnstileHandle, Props>(function TurnstileWidget({ siteKey, onToken, onStatus }, ref) {
  const box = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const alive = useRef(false);
  // 콜백은 최신 값을 쓰되 위젯을 다시 그리지 않도록 ref로 둔다
  const cb = useRef({ onToken, onStatus });
  cb.current = { onToken, onStatus };

  useImperativeHandle(ref, () => ({
    reset() {
      cb.current.onToken(null);
      const api = window.turnstile;
      const id = widgetId.current;
      if (!alive.current || !api || !id) return false;
      try {
        api.reset(id);
        cb.current.onStatus('loading');
        return true;
      } catch {
        cb.current.onStatus('error');
        return false;
      }
    },
  }), []);

  useEffect(() => {
    let cancelled = false;
    alive.current = true;
    // 늦게 도착한 콜백(정리 뒤·다른 위젯)은 무시한다
    const live = () => !cancelled;
    cb.current.onToken(null);
    cb.current.onStatus('loading');
    loadTurnstile()
      .then((api) => {
        if (!live() || !box.current || widgetId.current) return; // 정리됐거나 이미 그린 경우(중복 마운트) 다시 그리지 않음
        let id: string | undefined;
        try {
          id = api.render(box.current, {
            sitekey: siteKey,
            action: TURNSTILE_ACTION,
            'refresh-expired': 'manual',
            callback: (token: unknown) => {
              if (!live()) return;
              if (typeof token === 'string' && token.length > 0 && token.length <= 2048) {
                cb.current.onToken(token);
                cb.current.onStatus('ready');
              } else {
                cb.current.onToken(null);
                cb.current.onStatus('error');
              }
            },
            'expired-callback': () => {
              if (!live()) return;
              cb.current.onToken(null);
              cb.current.onStatus('expired');
            },
            'error-callback': () => {
              if (!live()) return;
              cb.current.onToken(null);
              cb.current.onStatus('error');
              return true; // 위젯 기본 오류 처리는 그대로 둔다
            },
          });
        } catch {
          id = undefined;
        }
        if (typeof id === 'string' && id.length > 0) widgetId.current = id;
        else if (live()) cb.current.onStatus('error'); // render 실패·ID 미반환: 무한 로딩으로 두지 않는다
      })
      .catch(() => {
        if (live()) {
          cb.current.onToken(null);
          cb.current.onStatus('error');
        }
      });
    return () => {
      cancelled = true;
      alive.current = false;
      const api = window.turnstile;
      const id = widgetId.current;
      widgetId.current = null;
      if (api && id) {
        try {
          api.remove(id);
        } catch {
          // 제거 실패는 화면 상태에 영향을 주지 않는다
        }
      }
      cb.current.onToken(null);
    };
  }, [siteKey]);

  return <div ref={box} className="turnstile-box" />;
});
