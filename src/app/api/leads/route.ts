import { NextResponse } from 'next/server';
import { buildCreateLeadArgs, leadIntakeGate, LeadRejected } from '@/server/leads/intake';
import { createPiiCrypto, piiKeysFromEnv } from '@/server/security/piiCrypto';
import { signingKeyFromEnv } from '@/server/security/token';
import { verifyTurnstile } from '@/server/leads/turnstile';
import { withRole } from '@/server/db/client';
import { clientIpFrom } from '@/server/http/clientIp';

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
  const raw = await req.text();
  if (raw.length > 4096) return rejected('PAYLOAD_TOO_LARGE', 413);

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return rejected('INVALID_JSON');
  }

  const ip = clientIpFrom((name) => req.headers.get(name));
  const { turnstileToken, ...lead } = body;
  if (!(await verifyTurnstile(String(turnstileToken ?? ''), ip))) return rejected('BOT_SUSPECTED', 403);

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
    if (e instanceof LeadRejected) return rejected(e.code);
    const code = (e as { code?: string }).code;
    if (code === '54000') return rejected('RATE_LIMITED', 429);
    if (code === '55000') return rejected('SERVICE_NOT_READY', 503);
    if (code === '22023') return rejected('INVALID_INPUT');
    console.error('[lead] unexpected', code); // 개인정보를 로그에 남기지 않는다
    return rejected('INTERNAL', 500);
  }
}
