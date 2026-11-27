'use client';

import { useEffect } from 'react';
import { resolveAttribution } from '../content/attribution';

/** 어느 페이지로 들어와도 첫 유입 출처를 탭 세션에 남긴다. 화면에는 아무것도 그리지 않는다 */
export function AttributionCapture() {
  useEffect(() => {
    try { resolveAttribution(window.location.search, window.sessionStorage); } catch { /* 저장소 접근 불가 */ }
  }, []);
  return null;
}
