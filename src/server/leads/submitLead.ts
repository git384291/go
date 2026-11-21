import { REQUIRED_NOTICES } from '../../content/requiredNotices';
import { buildCreateLeadArgs, LeadRejected, noticeHashes, type IntakeContext } from './intake';

/**
 * 접수 처리 핵심(검증 → 암호화·서명 → api.create_lead 저장). route.ts와 통합 시험이 같은 코드를 쓴다.
 * 봇 확인·본문 파싱은 route.ts가 먼저 처리한다. DB 실행기는 호출자가 넣는다(운영: withRole('public')).
 */
export type PublicSql = (strings: TemplateStringsArray, ...values: unknown[]) => PromiseLike<unknown>;
export type PublicRunner = (fn: (tx: PublicSql) => PromiseLike<unknown>) => Promise<unknown>;
/** created=새 접수 · already=같은 연락처의 같은 내용(저장 없음, 재문의 기록만) · amended=같은 연락처의 다른 내용(원본 유지, 변경 요청 기록) */
export type SubmitOutcome = 'created' | 'already' | 'amended';
export type SubmitResult = { ok: true; outcome: SubmitOutcome } | { ok: false; code: string; status: number };
const firstValue = (rows: unknown): unknown => { const r = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined; return r ? Object.values(r)[0] : undefined; };

/** DB 게이트(api.notice_intake_gate)가 접수를 막을 때 돌려주는 오류 메시지(문구·개인정보 없음). 모두 503으로 닫는다 */
const GATE_CODES = new Set(['NOTICE_INVALID', 'NOTICE_VERSION_MISMATCH', 'NOTICE_NOT_FOUND', 'NOTICE_KEYS_MISMATCH', 'NOTICE_HASH_MISMATCH', 'NOTICE_NOT_APPROVED', 'NOTICE_CHANGED', 'NOTICE_SELF_APPROVED']);

export { noticeHashes };

export async function submitLead(lead: unknown, ctx: IntakeContext, run: PublicRunner): Promise<SubmitResult> {
  const rejected = (code: string, status = 400): SubmitResult => ({ ok: false, code, status });
  try {
    const a = buildCreateLeadArgs(lead, ctx);
    // 접수 직전 서버가 DB에 확인한다: 접수 문서 버전·DB 고지 문구 해시·검수 승인 상태가 서버 상수와 모두 맞아야 한다(하나라도 다르면 저장하지 않음)
    const notices = ctx.notices ?? REQUIRED_NOTICES;
    const hashes = JSON.stringify(noticeHashes(notices));
    let outcome: SubmitOutcome = 'created';
    await run(async (tx) => {
      await tx`select api.notice_intake_gate(${notices.version}, ${hashes}::text::jsonb)`;
      await tx`
      select api.create_lead(${a.token}, ${a.nameEnc}, ${a.nameMasked}, ${a.phoneEnc}, ${a.phoneHmac}, ${a.phoneLast4},
                             ${a.interest}, ${a.contactTime}, ${a.utmSource}, ${a.utmMedium}, ${a.utmCampaign},
                             ${a.idempotencyKey}, ${a.privacyVersion}, ${a.consentCollection}, ${a.marketingOptIn}, ${a.ipHash})`;
      // 신청서 저장도 같은 트랜잭션: 여기서 실패하면 접수(리드)도 함께 취소된다
      if (a.application) {
        const saved = firstValue(await tx`select api.application_save(${a.application.token}, ${a.application.idempotencyKey}, ${a.application.payloadEnc}, ${a.application.summary}) as r`);
        // 'skipped' = 리드가 새로 만들어지지 않음(같은 연락처 재접수). 원본은 그대로 두고 같은 내용인지 비교, 다르면 변경 요청으로 따로 저장한다
        // 'saved'(새 접수)도 같은 비교를 한 번 거친다: 방금 저장한 원본과 같으므로 항상 'same'(쓰기 없음). 새 접수와 재접수의 DB 호출 수를 같게 해
        // 응답 시간 차이로 연락처 존재 여부를 추측하기 어렵게 한다(PM 11/22 P2). 'exists'(같은 요청 키 재전송)는 기존대로 비교하지 않는다
        if (saved === 'skipped' || saved === 'saved') {
          const m = a.application.amendment;
          const r = firstValue(await tx`select api.application_amend(${m.token}, ${a.application.idempotencyKey}, ${m.phoneHmac}, ${a.application.payloadEnc}, ${a.application.summary}, ${m.contentHmac}) as r`);
          if (saved === 'skipped') outcome = r === 'amended' ? 'amended' : r === 'same' ? 'already' : 'created';
        }
      }
      return null;
    });
    return { ok: true, outcome };
  } catch (e) {
    if (e instanceof LeadRejected) return rejected(e.code, e.code === 'PRODUCT_NOT_ACTIVE' ? 403 : e.code === 'NOTICE_NOT_CONFIRMED' || e.code === 'NOTICE_HASH_MISMATCH' ? 503 : 400);
    const code = (e as { code?: string }).code;
    if (code === '54000') return rejected('RATE_LIMITED', 429);
    const msg = String((e as { message?: unknown }).message ?? '').trim();
    if (code === '55000' && GATE_CODES.has(msg)) return rejected(msg, 503);
    if (code === '55000') return rejected('SERVICE_NOT_READY', 503);
    if (code === '22023') return rejected('INVALID_INPUT');
    if (code === 'FP001') return rejected('PRODUCT_NOT_ACTIVE', 403); // DB 상품 상태가 예약(코드와 불일치 포함)
    console.error('[lead] unexpected', code); // 개인정보를 로그에 남기지 않는다
    return rejected('INTERNAL', 500);
  }
}
