import { clientIpFrom, diagIpEnabled } from '@/server/http/clientIp';
import { createPiiCrypto, piiKeysFromEnv } from '@/server/security/piiCrypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 검수 배포 전용 진단(REV-005 3항): 서버가 판별한 고객 IP의 HMAC 앞 8자리만 돌려준다.
 * 원문 IP·헤더 값은 응답·로그에 남기지 않는다.
 * scripts/verify-ip-spoofing.sh가 위조 헤더를 바꿔 가며 호출해 결과가 변하지 않는지 확인한다.
 */
export async function GET(req: Request) {
  if (!diagIpEnabled(process.env)) return new Response('Not Found', { status: 404 });
  const ip = clientIpFrom((name) => req.headers.get(name));
  const bucket = createPiiCrypto(piiKeysFromEnv()).ipHash(ip).slice(0, 8);
  return Response.json({ bucket, fallback: ip === '0.0.0.0' }, { headers: { 'cache-control': 'no-store' } });
}
