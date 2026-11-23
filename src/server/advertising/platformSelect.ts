import 'server-only';
import { createPlatform, type AdPlatform } from './platform';
import { createGoogleAdsPlatform, googleAdsConfigFromEnv } from './googleAdsPlatform';
import { googleAdsFetchTransport } from './googleAdsTransport';
import { approvedKeywords, approvedRsaCreative, landingUrlFrom } from './googleAdsCreative';

/**
 * 광고 플랫폼 선택(PM 11/23 B 승인). 서버(adRun·adMonitor)는 이것만 쓴다.
 * - AD_PLATFORM=mock → 모의(과금 없음). AD_PLATFORM=google_ads → 인증 정보 4종·AD_LANDING_URL·검수 소재가 모두 있을 때만 Google Ads, 하나라도 없으면 null(닫힘).
 * - 인증 정보·최종 URL·검수 소재·승인 키워드(EXACT)가 모두 있어야 하고, 키워드가 비면 null(닫힘).
 * - Google Ads 어댑터는 캠페인·광고 그룹·키워드·광고를 모두 PAUSED로 만든다(initialStatus를 넘기지 않음 = 기본 PAUSED). 활성화 기능은 없다.
 * - 새 집행(launch)은 이것과 별도로 AD_EXECUTION_ENABLED=true + DB 예산 승인이 있어야만 일어난다(adRun). 기본은 모두 꺼짐.
 */
export function selectAdPlatform(env: Readonly<Record<string, string | undefined>>): AdPlatform | null {
  if (env.AD_PLATFORM !== 'google_ads') return createPlatform(env);
  const creative = approvedRsaCreative();
  const landingUrl = landingUrlFrom(env.AD_LANDING_URL);
  const keywords = approvedKeywords();
  if (!creative || !landingUrl || !keywords) return null;
  return createGoogleAdsPlatform({ ...googleAdsConfigFromEnv(env, googleAdsFetchTransport), creative, landingUrl, keywords });
}
