// 상품 소개 문구. 금액·사은품은 표시하지 않는다(정책 승인 구조 완성 전, REV-001 BIZ-01 / REV-004).
export type ProductSlug = 'internet-tv' | 'internet-phone' | 'cctv-security';

export type Product = {
  slug: ProductSlug;
  interest: 'internet_tv' | 'internet_phone' | 'cctv_security';
  label: string;
  title: string;
  lead: string;
  forWhom: string[];
  options: { name: string; desc: string }[];
  checks: string[];
};

export const CARRIERS = ['KT', 'LG U+', 'SK브로드밴드'] as const;

export const PRODUCTS: Product[] = [
  {
    slug: 'internet-tv',
    interest: 'internet_tv',
    label: '인터넷 + TV',
    title: '인터넷과 TV를 한 번에',
    lead: '집에서 쓰는 인터넷 속도와 보고 싶은 채널 구성을 먼저 듣고, 통신사별 결합 조건을 비교해 드립니다.',
    forWhom: ['이사·신규 설치를 앞둔 집', '약정 만료가 다가오는 집', 'TV 채널 구성을 바꾸고 싶은 집'],
    options: [
      { name: '인터넷 속도', desc: '100M · 500M · 1G 중 사용 기기 수와 생활 패턴에 맞춰 상담' },
      { name: 'TV 구성', desc: '기본 채널부터 키즈·스포츠·영화 중심 구성까지' },
      { name: '셋톱박스·공유기', desc: '설치 대수와 와이파이 범위를 함께 확인' },
    ],
    checks: [
      '요금과 사은품은 상담 시점의 확정 조건으로 안내합니다.',
      '약정 기간 안에 해지하면 통신사 약관에 따른 위약금이 생길 수 있습니다.',
      '통신사를 옮기는 경우 기존 회선 유지 조건은 상품마다 다르며 상담 때 안내합니다.',
    ],
  },
  {
    slug: 'internet-phone',
    interest: 'internet_phone',
    label: '인터넷 + 집전화',
    title: '인터넷과 집전화 결합',
    lead: '가게·사무실·집 어디서든 유선 전화가 필요하다면 인터넷과 묶어 관리를 단순하게 만들 수 있습니다.',
    forWhom: ['매장 대표번호가 필요한 사업장', '부모님 댁 유선 전화', '기존 번호를 그대로 쓰고 싶은 경우'],
    options: [
      { name: '집전화 종류', desc: '일반 유선 전화 · 인터넷 전화 중 사용 환경에 맞춰' },
      { name: '번호 이동', desc: '쓰던 번호 유지 가능 여부를 접수 전에 확인' },
      { name: '인터넷 속도', desc: '포스기·카드 단말기 사용 여부까지 고려해 추천' },
    ],
    checks: [
      '요금과 사은품은 상담 시점의 확정 조건으로 안내합니다.',
      '번호 이동 가능 여부는 현재 통신사와 회선 상태에 따라 달라집니다.',
      '약정 기간 안에 해지하면 통신사 약관에 따른 위약금이 생길 수 있습니다.',
    ],
  },
  {
    slug: 'cctv-security',
    interest: 'cctv_security',
    label: 'CCTV · 보안',
    title: '매장과 집을 지키는 CCTV · 보안',
    lead: '설치 장소의 구조와 사각지대를 먼저 듣고, 필요한 카메라 수와 녹화·원격 확인 방식을 함께 정합니다.',
    forWhom: ['카운터·창고가 있는 매장', '현관·주차장을 확인하고 싶은 주택', '인터넷 설치와 함께 보안을 갖추려는 곳'],
    options: [
      { name: '카메라 수·위치', desc: '출입구, 계산대, 창고 등 꼭 봐야 할 곳부터' },
      { name: '원격 확인', desc: '휴대폰으로 실시간·녹화 영상 확인' },
      { name: '인터넷 결합', desc: '인터넷 신규·변경과 함께 설치 일정 조율' },
    ],
    checks: [
      '요금과 설치 조건은 현장 구조 확인 후 확정해 안내합니다.',
      '촬영 범위와 안내문 부착 등 영상정보 관련 법령 준수 사항을 함께 안내합니다.',
      '약정 기간 안에 해지하면 약관에 따른 위약금이 생길 수 있습니다.',
    ],
  },
];

export const productBySlug = (slug: ProductSlug) => {
  const p = PRODUCTS.find((x) => x.slug === slug);
  if (!p) throw new Error(`unknown product ${slug}`);
  return p;
};

export const KAKAO_CHANNEL_URL = process.env.NEXT_PUBLIC_KAKAO_CHANNEL_URL ?? '#kakao-channel';
