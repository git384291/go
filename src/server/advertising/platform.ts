/**
 * 광고 플랫폼 교체형 인터페이스(PM 11/21). 실제 광고 API 어댑터는 만들지 않았다 — 지금은 무료 모의 어댑터만 있다.
 * - live=false(모의): 아무 곳에도 과금·집행하지 않는다. 집행·성과는 가상 값이다.
 * - live=true인 어댑터가 생기면 서버가 AD_EXECUTION_ENABLED=true(기본 꺼짐)와 DB 예산 승인 둘 다 통과해야만 launch를 부른다.
 * - 키·토큰은 서버 환경변수에서만 읽는 자리이며 이 인터페이스의 입출력에 나오지 않는다.
 */
export type LaunchRequest = { readonly campaign: string; readonly amountKrw: number; readonly requestKey: string };
export type AdPlatform = {
  readonly name: string;
  readonly live: boolean;
  launch(req: LaunchRequest): Promise<{ readonly externalId: string }>;
  /** 하루치 성과. 형식 검증은 호출측(서버)이 한다 — 어댑터 값은 믿지 않는다 */
  fetchPerformance(campaign: string, day: string): Promise<unknown>;
};

const hash = (s: string) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; return h; };

export const mockPlatform: AdPlatform = Object.freeze({
  name: 'mock',
  live: false,
  async launch(req) { return { externalId: `mock-${hash(req.campaign + req.requestKey).toString(16)}` }; },
  async fetchPerformance(campaign, day) {
    const h = hash(`${campaign}:${day}`);
    const impressions = 500 + (h % 2000);
    const clicks = Math.floor(impressions * (0.01 + ((h >>> 8) % 40) / 1000));
    return { impressions, clicks, costKrw: clicks * 10 };
  },
});

export function createPlatform(env: Readonly<Record<string, string | undefined>>): AdPlatform | null {
  return env.AD_PLATFORM === 'mock' ? mockPlatform : null;
}
