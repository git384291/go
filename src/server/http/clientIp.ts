/**
 * 상담 신청의 IP별 횟수 제한에 쓰는 고객 IP.
 *
 * x-forwarded-for의 첫 값은 요청을 보낸 쪽이 임의로 넣을 수 있다(예: 매번 다른 가짜 IP를 넣어
 * IP별 횟수 제한을 피함). 그래서 다음 순서로 읽는다.
 *   1) x-real-ip: Vercel이 직접 설정하는 값
 *   2) x-forwarded-for의 마지막 값: 가장 가까운 프록시가 덧붙인 값
 * 둘 다 없거나 IP 형식이 아니면 '0.0.0.0'(모든 요청이 같은 횟수 제한 버킷을 공유 → 안전한 쪽으로 실패).
 *
 * [1주차 확인] Vercel이 두 헤더를 덮어쓰는 동작을 운영 배포 전 검수 환경에서 요청 로그로 확인한다.
 */
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9a-f:]{2,39}$/i;

export function isIp(value: string): boolean {
  return IPV4.test(value) || (IPV6.test(value) && value.includes(':'));
}

export function clientIpFrom(header: (name: string) => string | null | undefined): string {
  const real = (header('x-real-ip') ?? '').trim();
  if (isIp(real)) return real;
  const forwarded = (header('x-forwarded-for') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const last = forwarded.at(-1) ?? '';
  return isIp(last) ? last : '0.0.0.0';
}
