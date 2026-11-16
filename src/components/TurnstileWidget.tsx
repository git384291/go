'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

// Cloudflare Turnstile 위젯(명시적 렌더). 폼이 켜져 있고 공개 사이트 키가 있을 때만 부모가 이 컴포넌트를 그린다.
// 이 컴포넌트가 그려지지 않으면 스크립트·iframe·외부 요청이 하나도 생기지 않는다.
// - action은 서버 검증(verifyTurnstile)과 같은 'lead_form'으로 고정한다.
// - 봇 토큰은 일회용이다. 부모가 서버 응답을 받은 뒤 reset()으로 새 토큰을 받는다. 사업 요청 키와 섞지 않는다.
// - 토큰은 부모 메모리로만 넘긴다(저장소·URL·로그 없음).

export const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
export const TURNSTILE_ACTION = 'lead_form';

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
export type TurnstileHandle = { reset: () => void };

let scriptPromise: Promise<TurnstileApi> | null = null;

/** 스크립트는 페이지당 한 번만 넣는다(중복 마운트·재렌더에도 한 번) */
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<TurnstileApi>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = TURNSTILE_SCRIPT_URL;
    s.async = true;
    s.defer = true;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile_unavailable')));
    s.onerror = () => reject(new Error('turnstile_load_failed'));
    document.head.appendChild(s);
  }).catch((e: unknown) => {
    scriptPromise = null; // 실패하면 다음 마운트에서 다시 시도할 수 있게
    throw e;
  });
  return scriptPromise;
}

type Props = {
  siteKey: string;
  onToken: (token: string | null) => void;
  onStatus: (status: TurnstileStatus) => void;
};

export const TurnstileWidget = forwardRef<TurnstileHandle, Props>(function TurnstileWidget({ siteKey, onToken, onStatus }, ref) {
  const box = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  // 콜백은 최신 값을 쓰되 위젯을 다시 그리지 않도록 ref로 둔다
  const cb = useRef({ onToken, onStatus });
  cb.current = { onToken, onStatus };

  useImperativeHandle(ref, () => ({
    reset() {
      cb.current.onToken(null);
      const api = window.turnstile;
      if (api && widgetId.current) {
        cb.current.onStatus('loading');
        api.reset(widgetId.current);
      }
    },
  }), []);

  useEffect(() => {
    let cancelled = false;
    cb.current.onStatus('loading');
    loadTurnstile()
      .then((api) => {
        if (cancelled || !box.current || widgetId.current) return; // 정리됐거나 이미 그린 경우(중복 마운트) 다시 그리지 않음
        widgetId.current =
          api.render(box.current, {
            sitekey: siteKey,
            action: TURNSTILE_ACTION,
            'refresh-expired': 'manual',
            callback: (token: unknown) => {
              if (typeof token === 'string' && token.length > 0 && token.length <= 2048) {
                cb.current.onToken(token);
                cb.current.onStatus('ready');
              } else {
                cb.current.onToken(null);
                cb.current.onStatus('error');
              }
            },
            'expired-callback': () => {
              cb.current.onToken(null);
              cb.current.onStatus('expired');
            },
            'error-callback': () => {
              cb.current.onToken(null);
              cb.current.onStatus('error');
              return true; // 위젯 기본 오류 처리(재시도 안내)는 그대로 둔다
            },
          }) ?? null;
      })
      .catch(() => {
        if (!cancelled) {
          cb.current.onToken(null);
          cb.current.onStatus('error');
        }
      });
    return () => {
      cancelled = true;
      const api = window.turnstile;
      if (api && widgetId.current) {
        try {
          api.remove(widgetId.current);
        } catch {
          // 이미 제거된 위젯이면 무시
        }
      }
      widgetId.current = null;
      cb.current.onToken(null);
    };
  }, [siteKey]);

  return <div ref={box} className="turnstile-box" />;
});
