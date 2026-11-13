/**
 * 상담 신청의 IP별 횟수 제한에 쓰는 고객 IP.
 *
 * Vercel 공식 문서(Request headers): Vercel은 x-forwarded-for를 덮어쓰고 외부에서 넣은 IP를
 * 전달하지 않으며(IP 위조 방지), x-real-ip는 그와 같은 값이다.
 *   → Vercel에서 실행 중이면(VERCEL=1) x-real-ip만 쓴다. 다른 헤더로 대체하지 않는다.
 *
 * Vercel 밖(로컬 개발): 앞에 프록시가 없으므로 어떤 헤더든 요청자가 임의로 넣을 수 있다.
 *   로컬에서는 상담 신청이 로컬 가상 DB로만 열리므로(leadIntakeGate) 편의상
 *   x-real-ip → x-forwarded-for 마지막 값 순으로 읽는다.
 *
 * 값이 없거나 IP 형식이 아니면 '0.0.0.0'(모든 요청이 같은 횟수 제한 버킷 → 안전한 쪽으로 실패).
 * 실제 배포 환경 확인: scripts/verify-ip-spoofing.sh (검수 배포 + /api/diag/ip)
 */
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9a-f:]{2,39}$/i;

export function isIp(value: string): boolean {
  return IPV4.test(value) || (IPV6.test(value) && value.includes(':'));
}

export type ClientIpOptions = { onVercel: boolean };

/** /api/diag/ip 진단 경로는 검수(프리뷰) 배포에서 명시적으로 켰을 때만 열린다. 운영·로컬에서는 404 */
export function diagIpEnabled(env: Record<string, string | undefined>): boolean {
  return env.VERCEL === '1' && env.VERCEL_ENV === 'preview' && env.DIAG_IP_ENABLED === '1';
}

export function clientIpFrom(
  header: (name: string) => string | null | undefined,
  opts: ClientIpOptions = { onVercel: process.env.VERCEL === '1' },
): string {
  const real = (header('x-real-ip') ?? '').trim();
  if (opts.onVercel) return isIp(real) ? real : '0.0.0.0';

  if (isIp(real)) return real;
  const forwarded = (header('x-forwarded-for') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const last = forwarded.at(-1) ?? '';
  return isIp(last) ? last : '0.0.0.0';
}
