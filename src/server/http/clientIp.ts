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

/**
 * 횟수 제한(IP별 버킷)용 키. IPv4는 그대로, IPv6는 /64 접두사로 묶는다.
 * 한 가입자가 보통 /64 전체(2^64개 주소)를 받으므로, 주소 하나마다 버킷을 주면 주소만 바꿔 IP별 세션·메시지 한도를
 * 무한히 우회할 수 있다(→ 세션 재발급으로 사용자별 AI 한도 우회). 원문 IP는 여기서도 저장하지 않는다(호출부가 HMAC).
 * 해석할 수 없는 IPv6는 '0.0.0.0'(공용 버킷, 안전한 쪽으로 실패).
 */
export function rateLimitIpKey(ip: string): string {
  if (!ip.includes(':')) return ip;
  const s = ip.toLowerCase();
  const parts = s.split('::');
  if (parts.length > 2) return '0.0.0.0';
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const fill = parts.length === 2 ? 8 - head.length - tail.length : 0;
  if (parts.length === 2 ? fill < 1 : head.length !== 8) return '0.0.0.0';
  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return '0.0.0.0';
  // IPv4 대응 IPv6(::ffff:a.b, 16진 표기)는 그 IPv4로 — /64로 묶으면 모든 대응 주소가 한 버킷('0:0:0:0::/64')이 된다(PR #13에서 반영)
  const n = groups.map((g) => parseInt(g, 16));
  if (n.slice(0, 5).every((x) => x === 0) && n[5] === 0xffff) return `${n[6]! >> 8}.${n[6]! & 255}.${n[7]! >> 8}.${n[7]! & 255}`;
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}
