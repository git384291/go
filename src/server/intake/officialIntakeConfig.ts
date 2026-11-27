import 'server-only';
// 총판 공식 접수 경로 — 서버 전용 설정 (PM 6920265190 / 6920404685).
//
// 현재 상태: 꺼짐 + 빈 등록부. 고객 화면에는 링크·버튼·외부 스크립트·iframe·요청이 생기지 않는다.
// - 이 값은 코드 상수다. 환경변수·URL query·고객 입력으로 켜거나 목적지를 바꿀 수 없다.
// - 켜려면 (1) 총판 공식 접수 경로·딜러 귀속·개인정보 처리 주체·광고 목적지 허용을 사람이 확인하고
//   (2) 등록 항목과 활성 변경을 별도 커밋으로 PM이 검수해야 한다. 이 준비 코드는 외부 상담·접수 개방 승인이 아니다.
// - tests/unit/official-intake.test.ts(정적 확인)와 tests/route/official-intake-config.test.ts가 기본값을 확인한다.
import { resolveOfficialIntake, type OfficialIntakeEntry, type OfficialIntakeResult } from '@/content/officialIntake';
import type { ProductSlug } from '@/content/products';

export const OFFICIAL_INTAKE_ENABLED: boolean = false;

export const OFFICIAL_INTAKE_REGISTRY: readonly OfficialIntakeEntry[] = Object.freeze([]);

/** 화면용 판정. 상품만 받고, 요청·고객 입력은 받지 않는다. */
export function officialIntakeFor(slug: ProductSlug): OfficialIntakeResult {
  return resolveOfficialIntake({ enabled: OFFICIAL_INTAKE_ENABLED, registry: OFFICIAL_INTAKE_REGISTRY, slug });
}
