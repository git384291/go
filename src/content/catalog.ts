// 상품 활성 상태의 유일한 기준(코드 쪽). FIDEON PM PHASE 1.
//
// - 현재 활성 상품은 인터넷+TV 하나뿐이다.
// - 나머지는 '예약(reserved)': 화면·데이터 구조는 보존하지만 고객 노출·상담 접수·광고·외부 연동을 하지 않는다.
// - 이 값은 환경변수나 요청 값으로 바꿀 수 없다. 바꾸려면 코드 변경 + PM 검수 + DB 2인 승인(0004)이 모두 필요하다.
// - DB의 core.product_catalog 기준값과 반드시 같아야 한다(tests/unit/catalog.test.ts가 대조).
//   둘 중 한쪽이라도 '예약'이면 상담 신청은 차단된다(서버와 DB가 각각 검사).
//
// 동판: 정의가 확정되지 않아 키를 만들지 않는다(PHASE 1 지시 4).

export type CatalogKey = 'internet_tv' | 'internet_phone' | 'internet_only' | 'cctv_security' | 'other' | 'mobile';
export type CatalogStatus = 'active' | 'reserved';

type Entry = { readonly status: CatalogStatus; readonly label: string; readonly note: string };

export const CATALOG: Readonly<Record<CatalogKey, Entry>> = Object.freeze({
  internet_tv: Object.freeze({ status: 'active', label: '인터넷 + TV', note: '현재 유일한 운영 상품' }),
  internet_phone: Object.freeze({ status: 'reserved', label: '인터넷 + 집전화', note: '기존 화면 보존, 비노출' }),
  internet_only: Object.freeze({ status: 'reserved', label: '인터넷만', note: '상담 대상 고정(인터넷+TV)으로 비노출' }),
  cctv_security: Object.freeze({ status: 'reserved', label: 'CCTV · 보안', note: '사업자등록 이후 사업, 기존 화면 보존' }),
  other: Object.freeze({ status: 'reserved', label: '잘 모르겠어요', note: '상담 대상 고정(인터넷+TV)으로 비노출' }),
  mobile: Object.freeze({ status: 'reserved', label: '휴대폰', note: '사업자등록 이후 사업, 예약 설계만(화면·접수 없음)' }),
} as const satisfies Record<CatalogKey, Entry>);

/** 알 수 없는 값·예약 상품은 모두 false. 대소문자·공백 변형도 허용하지 않는다. */
export function isActiveInterest(key: unknown): boolean {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(CATALOG, key) && CATALOG[key as CatalogKey].status === 'active';
}

export const ACTIVE_INTERESTS: readonly CatalogKey[] = Object.freeze(
  (Object.keys(CATALOG) as CatalogKey[]).filter((k) => CATALOG[k].status === 'active'),
);

/** 상담 신청의 고정 대상. 활성 상품이 정확히 하나가 아니면 빌드·실행 단계에서 바로 드러나도록 예외를 던진다. */
export function fixedConsultInterest(): CatalogKey {
  if (ACTIVE_INTERESTS.length !== 1) throw new Error(`expected exactly one active product, got ${ACTIVE_INTERESTS.length}`);
  return ACTIVE_INTERESTS[0];
}
