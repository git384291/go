import { NextResponse } from 'next/server';
import { buildCreateLeadArgs, leadIntakeGate, LeadRejected } from '@/server/leads/intake';
import { createPiiCrypto, piiKeysFromEnv } from '@/server/security/piiCrypto';
import { signingKeyFromEnv } from '@/server/security/token';
import { verifyTurnstile } from '@/server/leads/turnstile';
import { withRole } from '@/server/db/client';
import { clientIpFrom } from '@/server/http/clientIp';
import { isActiveInterest } from '@/content/catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 고객에게는 신규·중복·내부 오류를 구분하지 않고 같은 형태로 응답한다
const accepted = () => NextResponse.json({ ok: true }, { status: 202 });
const rejected = (code: string, status = 400) => NextResponse.json({ ok: false, code }, { status });

export async function POST(req: Request) {
  // REV-004: 실제 고객정보 수집·운영 DB 저장은 재검수 통과 전까지 비활성
  const gate = leadIntakeGate(process.env);
  if (!gate.enabled) return rejected(gate.reason, 503);

  if (!(req.headers.get('content-type') ?? '').includes('application/json')) return rejected('UNSUPPORTED_MEDIA', 415);
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return rejected('INVALID_JSON');
  }
  if (raw.length > 4096) return rejected('PAYLOAD_TOO_LARGE', 413);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return rejected('INVALID_JSON');
  }
  // 루트는 일반 객체만(null·배열·문자열·숫자는 구조 분해 전에 거부한다)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return rejected('INVALID_JSON');
  const body = parsed as Record<string, unknown>;

  const ip = clientIpFrom((name) => req.headers.get(name));
  const { turnstileToken, ...lead } = body;
  // PHASE 1: 예약 상품은 외부 확인(Turnstile) 호출 전에 바로 거부한다
  if (!isActiveInterest(lead.interest)) return rejected('PRODUCT_NOT_ACTIVE', 403);
  // 봇 확인은 예외를 던지지 않는다. 'ok'가 아니면 저장으로 진행하지 않는다(외부 확인 실패 = 접수 안 함)
  const bot = await verifyTurnstile(typeof turnstileToken === 'string' ? turnstileToken : '', ip);
  if (bot === 'unavailable') return rejected('BOT_CHECK_UNAVAILABLE', 503);
  if (bot !== 'ok') return rejected('BOT_SUSPECTED', 403);

  try {
    const a = buildCreateLeadArgs(lead, {
      crypto: createPiiCrypto(piiKeysFromEnv()),
      signingKey: signingKeyFromEnv('lead'),
      currentPrivacyVersion: process.env.PRIVACY_POLICY_VERSION ?? '',
      clientIp: ip,
    });
    await withRole('public', (tx) => tx`
      select api.create_lead(${a.token}, ${a.nameEnc}, ${a.nameMasked}, ${a.phoneEnc}, ${a.phoneHmac}, ${a.phoneLast4},
                             ${a.interest}, ${a.contactTime}, ${a.utmSource}, ${a.utmMedium}, ${a.utmCampaign},
                             ${a.idempotencyKey}, ${a.privacyVersion}, ${a.consentCollection}, ${a.marketingOptIn}, ${a.ipHash})`);
    return accepted();
  } catch (e) {
    if (e instanceof LeadRejected) return rejected(e.code, e.code === 'PRODUCT_NOT_ACTIVE' ? 403 : 400);
    const code = (e as { code?: string }).code;
    if (code === '54000') return rejected('RATE_LIMITED', 429);
    if (code === '55000') return rejected('SERVICE_NOT_READY', 503);
    if (code === '22023') return rejected('INVALID_INPUT');
    if (code === 'FP001') return rejected('PRODUCT_NOT_ACTIVE', 403); // DB 상품 상태가 예약(코드와 불일치 포함)
    console.error('[lead] unexpected', code); // 개인정보를 로그에 남기지 않는다
    return rejected('INTERNAL', 500);
  }
}
