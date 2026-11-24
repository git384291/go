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
 * 횟수 제한용 회선 키(PM 11/24 세션 재발급 우회 방지). 사람 식별이 아니라 남용 방지 보조 키다(사용자 한도 키는 서명 세션).
 * - IPv4: 그대로. IPv4 대응 IPv6(::ffff:a.b)는 그 IPv4.
 * - IPv6: 앞 64비트(/64)로 묶는다. 한 가입 회선은 보통 /64 전체를 받아 주소를 마음대로(또는 자동으로) 바꿀 수 있으므로,
 *   주소 전체를 키로 쓰면 'IP당 새 세션 시간당 5개'가 무력화된다. 표기 차이(대소문자·0 생략·::)도 같은 키.
 * - 형식 밖은 '0.0.0.0'(모두 한 버킷 → 안전한 쪽으로 실패).
 */
export function rateKeyIp(ip: string): string {
  if (IPV4.test(ip)) return ip;
  if (typeof ip !== 'string' || !isIp(ip)) return '0.0.0.0';
  const parts = ip.toLowerCase().split('::');
  if (parts.length > 2) return '0.0.0.0';
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (parts.length === 1 ? fill !== 0 : fill < 1) return '0.0.0.0';
  const g = [...head, ...Array<string>(parts.length === 2 ? fill : 0).fill('0'), ...tail];
  if (g.length !== 8 || g.some((h) => !/^[0-9a-f]{1,4}$/.test(h))) return '0.0.0.0';
  const n = g.map((h) => parseInt(h, 16));
  if (n.slice(0, 5).every((x) => x === 0) && n[5] === 0xffff) return `${n[6]! >> 8}.${n[6]! & 255}.${n[7]! >> 8}.${n[7]! & 255}`;
  return `${n.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}
