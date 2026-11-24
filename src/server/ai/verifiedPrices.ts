// 공식 확인된 AI 모델 단가 기록(PM 11/24 ②). 상담 경로 가격표로 연결(openAiChatModel.consultModelFromEnv, PM 11/24 후속). 실제 전송·운영 활성화는
// 실제 접근 권한·모델 품질 검증과 별도 승인 뒤에만(라우트 transport null). 가격이 바뀌면 공식 문서를 다시 확인해 이 기록과 확인일을 함께 고친다.
// - 원화 가격표는 비용 계산용 보수적 환율(1,800원/USD, 실제 청구 환율 아님)로 바꾼 값이다(krwPriceFromUsd, 원 단위 올림).
// - 여기 없는 모델은 가격 불확실 → 호출 금지(priceFor null).
import { krwPriceFromUsd, type ModelPrice, type UsdModelPrice } from './costModel';

export type VerifiedUsdPrice = UsdModelPrice & { readonly sourceUrl: string; readonly verifiedOn: string };
export const VERIFIED_USD_PRICES: readonly VerifiedUsdPrice[] = Object.freeze([
  // 공식 모델 문서 확인: 입력 $0.20 · 캐시 입력 $0.02 · 출력 $1.20 (백만 토큰당), Responses API 지원
  Object.freeze({ model: 'gpt-5.6-luna', inputMicroUsdPerMTok: 200_000, cachedInputMicroUsdPerMTok: 20_000, outputMicroUsdPerMTok: 1_200_000,
    sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-5.6-luna', verifiedOn: '2026-11-24' }),
]);

/** 확인 기록 → 원화 가격표. 출처·확인일이 없거나 변환이 실패한 항목은 넣지 않는다(→ 그 모델은 호출 금지) */
export function verifiedKrwPrices(table: readonly VerifiedUsdPrice[] = VERIFIED_USD_PRICES): readonly ModelPrice[] {
  const out: ModelPrice[] = [];
  for (const v of table) {
    if (!/^https:\/\/[^\s]+$/.test(v.sourceUrl ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(v.verifiedOn ?? '')) continue;
    const p = krwPriceFromUsd(v);
    if (p) out.push(p);
  }
  return Object.freeze(out);
}
