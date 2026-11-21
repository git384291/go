import { buildCreateLeadArgs, LeadRejected, type IntakeContext } from './intake';

/**
 * 접수 처리 핵심(검증 → 암호화·서명 → api.create_lead 저장). route.ts와 통합 시험이 같은 코드를 쓴다.
 * 봇 확인·본문 파싱은 route.ts가 먼저 처리한다. DB 실행기는 호출자가 넣는다(운영: withRole('public')).
 */
export type PublicSql = (strings: TemplateStringsArray, ...values: unknown[]) => PromiseLike<unknown>;
export type PublicRunner = (fn: (tx: PublicSql) => PromiseLike<unknown>) => Promise<unknown>;
export type SubmitResult = { ok: true } | { ok: false; code: string; status: number };

export async function submitLead(lead: unknown, ctx: IntakeContext, run: PublicRunner): Promise<SubmitResult> {
  const rejected = (code: string, status = 400): SubmitResult => ({ ok: false, code, status });
  try {
    const a = buildCreateLeadArgs(lead, ctx);
    await run((tx) => tx`
      select api.create_lead(${a.token}, ${a.nameEnc}, ${a.nameMasked}, ${a.phoneEnc}, ${a.phoneHmac}, ${a.phoneLast4},
                             ${a.interest}, ${a.contactTime}, ${a.utmSource}, ${a.utmMedium}, ${a.utmCampaign},
                             ${a.idempotencyKey}, ${a.privacyVersion}, ${a.consentCollection}, ${a.marketingOptIn}, ${a.ipHash})`);
    return { ok: true };
  } catch (e) {
    if (e instanceof LeadRejected) return rejected(e.code, e.code === 'PRODUCT_NOT_ACTIVE' ? 403 : e.code === 'NOTICE_NOT_CONFIRMED' ? 503 : 400);
    const code = (e as { code?: string }).code;
    if (code === '54000') return rejected('RATE_LIMITED', 429);
    if (code === '55000') return rejected('SERVICE_NOT_READY', 503);
    if (code === '22023') return rejected('INVALID_INPUT');
    if (code === 'FP001') return rejected('PRODUCT_NOT_ACTIVE', 403); // DB 상품 상태가 예약(코드와 불일치 포함)
    console.error('[lead] unexpected', code); // 개인정보를 로그에 남기지 않는다
    return rejected('INTERNAL', 500);
  }
}
