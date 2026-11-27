import 'server-only';
// 총판 공식 접수 경로 — 서버 전용 설정 (PM 6920265190 / 6920404685).
//
// 현재 상태: 바른365가 직접 운영하는 네이버 폼 1곳만 고정 등록·활성.
// - 이 값은 코드 상수다. 환경변수·URL query·고객 입력으로 켜거나 목적지를 바꿀 수 없다.
// - 사용자 공개 승인 뒤 실제 응답 화면·개인정보 동의·결과 비공개를 2026-11-28 04:33 KST에 확인했다.
// - 링크만 새 창으로 열며 홈페이지 서버는 고객 개인정보를 받거나 저장하지 않는다.
// - tests/unit/official-intake.test.ts(정적 확인)와 tests/route/official-intake-config.test.ts가 고정값을 확인한다.
import { resolveOfficialIntake, type OfficialIntakeEntry, type OfficialIntakeResult } from '@/content/officialIntake';
import type { ProductSlug } from '@/content/products';

export const OFFICIAL_INTAKE_ENABLED: boolean = true;

export const OFFICIAL_INTAKE_REGISTRY: readonly OfficialIntakeEntry[] = Object.freeze([
  Object.freeze({
    id: 'naver-form',
    label: '바른365',
    // 단축주소가 다른 곳으로 바뀌는 위험을 없애기 위해 검수한 최종 응답 주소를 고정한다.
    url: 'https://form.naver.com/response/By757YMGRuN',
    products: Object.freeze(['internet-tv'] as const),
    reviewRef: 'PM-202611280433',
  }),
]);

/** 화면용 판정. 상품만 받고, 요청·고객 입력은 받지 않는다. */
export function officialIntakeFor(slug: ProductSlug): OfficialIntakeResult {
  return resolveOfficialIntake({ enabled: OFFICIAL_INTAKE_ENABLED, registry: OFFICIAL_INTAKE_REGISTRY, slug });
}
