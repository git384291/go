// AI 호출 비용 계산(P0 TEST-10). **실제 가격은 코드에 두지 않는다**: 가격표는 승인된 공식 자료로 주입한다(지금은 시험용 가상 값만).
// - 정수 연산(BigInt)만 쓴다. 단가 = 백만 토큰당 원(정수). 예상 최대 비용은 올림(과소 계산 방지).
// - 통화는 KRW만. 다른 통화·환율 변환은 지원하지 않는다(→ 호출 금지).
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
