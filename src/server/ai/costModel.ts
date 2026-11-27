// AI 호출 비용 계산(P0 TEST-10). 가격표는 승인된 공식 자료로 주입한다(어댑터 설정 prices). 공식 확인된 단가 기록은 verifiedPrices.ts.
// - 정수 연산(BigInt)만 쓴다. 단가 = 백만 토큰당 원(정수). 예상 최대 비용은 올림(과소 계산 방지).
// - 계산 통화는 KRW만(priceFor는 KRW 외 거부). USD 공식 단가는 krwPriceFromUsd로만 원화 가격표로 바꾼다(PM 11/24 ②:
//   비용 계산용 보수적 환율, 원 단위 올림). **이 환율은 한도 계산용이며 실제 청구 환율이 아니다.**
// - 캐시 입력 할인은 상한 계산에 쓰지 않는다(할인은 비용을 줄일 뿐이므로 상한 = 전액 입력 단가).
// - 입력 토큰 상한 가정: 바이트 단위 BPE 계열 토크나이저는 토큰 수 ≤ UTF-8 바이트 수. **공급자별로 공식 확인 필요**(미확인 가정).
export type ModelPrice = {
  readonly model: string;
  readonly currency: string;
  readonly inputKrwPerMTok: number;
  readonly outputKrwPerMTok: number;
  readonly cachedInputKrwPerMTok?: number;
};
export type Usage = { readonly inputTokens: number; readonly outputTokens: number; readonly cachedInputTokens?: number };

const RATE_MAX = 10_000_000; // 백만 토큰당 1,000만 원 이하만 받는다(형식 검사용 상한, 실제 가격 아님)
const isRate = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= RATE_MAX;
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 10_000_000;

/** 가격표 검사: 모델명 일치·KRW·정수 단가. 하나라도 어긋나면 null(= 가격 불확실 → 호출 금지) */
export function priceFor(table: readonly ModelPrice[] | null | undefined, model: string): ModelPrice | null {
  if (!Array.isArray(table)) return null;
  const hits = table.filter((p) => p && p.model === model);
  if (hits.length !== 1) return null; // 없음·중복은 불확실
  const p = hits[0]!;
  if (p.currency !== 'KRW' || !isRate(p.inputKrwPerMTok) || !isRate(p.outputKrwPerMTok)) return null;
  if (p.cachedInputKrwPerMTok !== undefined && (!isRate(p.cachedInputKrwPerMTok) || p.cachedInputKrwPerMTok > p.inputKrwPerMTok)) return null;
  return p;
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
const M = 1_000_000n;

/** 요청 1회의 예상 최대 비용(원, 올림). 토큰 수가 잘못되면 null */
export function estimateMaxKrw(p: ModelPrice, maxInputTokens: number, maxOutputTokens: number): number | null {
  if (!isCount(maxInputTokens) || !isCount(maxOutputTokens)) return null;
  const micro = BigInt(maxInputTokens) * BigInt(p.inputKrwPerMTok) + BigInt(maxOutputTokens) * BigInt(p.outputKrwPerMTok);
  return Number(ceilDiv(micro, M));
}

/** 실제 사용량 비용(원, 올림). 사용량이 없거나 형식이 틀리면 null — 0원으로 간주하지 않는다(호출자는 예약 전액으로 정산) */
export function settleKrw(p: ModelPrice, u: unknown): number | null {
  if (typeof u !== 'object' || u === null) return null;
  const x = u as Record<string, unknown>;
  if (!isCount(x.inputTokens) || !isCount(x.outputTokens)) return null;
  const cached = x.cachedInputTokens === undefined ? 0 : x.cachedInputTokens;
  if (!isCount(cached) || cached > x.inputTokens) return null;
  const cachedRate = BigInt(p.cachedInputKrwPerMTok ?? p.inputKrwPerMTok);
  const micro = BigInt(x.inputTokens - cached) * BigInt(p.inputKrwPerMTok) + BigInt(cached) * cachedRate + BigInt(x.outputTokens) * BigInt(p.outputKrwPerMTok);
  return Number(ceilDiv(micro, M));
}

/** 입력 토큰 상한(가정: 토큰 ≤ UTF-8 바이트) */
export const inputTokenUpperBound = (text: string): number => new TextEncoder().encode(text).byteLength;

/** 비용 계산용 보수적 환율(PM 11/24 ②: 기준 1,500원 + 안전 여유 20% = 1,800원). **실제 청구 환율 아님** — 한도·예약 계산에만 쓴다 */
export const COST_ESTIMATE_FX_KRW_PER_USD = 1800;
/** USD 공식 단가(백만 토큰당 마이크로달러, 정수) */
export type UsdModelPrice = { readonly model: string; readonly inputMicroUsdPerMTok: number; readonly outputMicroUsdPerMTok: number; readonly cachedInputMicroUsdPerMTok?: number };
const isMicro = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 1_000_000_000;
/** USD 단가 → 원화 가격표(원 단위 올림). 값이 하나라도 이상하면 null(= 가격 불확실 → 호출 금지) */
export function krwPriceFromUsd(u: UsdModelPrice, fxKrwPerUsd: number = COST_ESTIMATE_FX_KRW_PER_USD): ModelPrice | null {
  if (!u || typeof u.model !== 'string' || u.model.length < 1) return null;
  if (!Number.isSafeInteger(fxKrwPerUsd) || fxKrwPerUsd < 1 || fxKrwPerUsd > 100_000) return null;
  if (!isMicro(u.inputMicroUsdPerMTok) || !isMicro(u.outputMicroUsdPerMTok)) return null;
  if (u.cachedInputMicroUsdPerMTok !== undefined && (!isMicro(u.cachedInputMicroUsdPerMTok) || u.cachedInputMicroUsdPerMTok > u.inputMicroUsdPerMTok)) return null;
  const krw = (micro: number) => Number(ceilDiv(BigInt(micro) * BigInt(fxKrwPerUsd), M));
  const p: ModelPrice = {
    model: u.model, currency: 'KRW', inputKrwPerMTok: krw(u.inputMicroUsdPerMTok), outputKrwPerMTok: krw(u.outputMicroUsdPerMTok),
    ...(u.cachedInputMicroUsdPerMTok !== undefined ? { cachedInputKrwPerMTok: krw(u.cachedInputMicroUsdPerMTok) } : {}),
  };
  return priceFor([p], u.model);
}
