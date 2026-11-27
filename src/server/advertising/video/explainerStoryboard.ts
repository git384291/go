import 'server-only';
// 30초 설명형 화면 시안 storyboard — **고정 계획 + 순수 검증** (PM 6983216833).
//
// - 대본은 PM 일반 인터넷 선택안 5문장(6982805159)이다. 결합 할인 유도·혜택·금액·상품 판정·실적·URL·전화·QR·CTA 없음.
// - 입력 API는 정확히 { variant: 'general_internet_v1' } 하나다. 문구·좌표·색·시간·경로를 입력으로 받지 않는다.
// - 그래픽은 고정 도형(둥근 사각형·원·고리·선·호)의 조합으로 직접 그린 아이콘이다(외부 이미지·아이콘 0).
// - 이 storyboard의 결과물은 **내부 검토용 무음 화면 시안**이다. 음성·음성 동기·판매용 완성 판정이 아니다.
// - validateExplainerPlan은 계획 전체를 한 번 읽어 동결 스냅샷을 만든다(정수 좌표·고정 색 형식·시간 범위·허용 문자).
//   renderer는 이 스냅샷만 쓴다.

export const EX_WIDTH = 720;
export const EX_HEIGHT = 1280;
export const EX_FPS = 30;
export const EX_DURATION_SEC = 30;
export const EX_FRAMES = EX_FPS * EX_DURATION_SEC;
export const EX_VARIANT = 'general_internet_v1';

/** 색(고정 팔레트) */
export const PAL = Object.freeze({
  bg: '0xf4f6fa',
  navy: '0x13294b',
  navySoft: '0x2b4470',
  teal: '0x1fb5a6',
  tealSoft: '0xd5f2ee',
  coral: '0xff6b5a',
  coralDark: '0xe0503f',
  coralSoft: '0xffe3df',
  sun: '0xffc94d',
  white: '0xffffff',
  ink: '0x1b2433',
  muted: '0x7d879a',
  line: '0xdfe4ec',
  screen: '0xcfe3ff',
});

export type Prim =
  | { readonly k: 'rect'; readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly r: number; readonly c: string; readonly o?: number }
  | { readonly k: 'outline'; readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly r: number; readonly t: number; readonly c: string; readonly o?: number }
  | { readonly k: 'circle'; readonly cx: number; readonly cy: number; readonly r: number; readonly c: string; readonly o?: number }
  | { readonly k: 'ring'; readonly cx: number; readonly cy: number; readonly r: number; readonly t: number; readonly c: string; readonly o?: number }
  | { readonly k: 'line'; readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number; readonly t: number; readonly c: string; readonly o?: number }
  | { readonly k: 'arc'; readonly cx: number; readonly cy: number; readonly r: number; readonly t: number; readonly c: string; readonly o?: number };

/** 한 장의 그림(작은 캔버스). 좌표는 캔버스 안 기준 */
export type Sprite = {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** 등장·퇴장 시각(초, 1/10초 단위 정수 ×10으로 보관하지 않고 소수 1자리까지 허용) */
  readonly tin: number;
  readonly tout: number;
  /** 등장 시 이동 시작 오프셋(px) */
  readonly dx: number;
  readonly dy: number;
  /** 위아래 미세 움직임 진폭(px, 0이면 없음) */
  readonly bob: number;
  readonly prims: readonly Prim[];
};

export type TextItem = {
  readonly id: string;
  readonly text: string;
  readonly size: number;
  readonly c: string;
  /** -1이면 가운데 정렬, 그 밖은 왼쪽 x */
  readonly x: number;
  readonly y: number;
  /** 이 줄이 넘으면 안 되는 실제 폭(px) */
  readonly maxW: number;
  readonly tin: number;
  readonly tout: number;
  readonly dy: number;
};

export type ExplainerPlan = { readonly variant: typeof EX_VARIANT; readonly sprites: readonly Sprite[]; readonly texts: readonly TextItem[] };

// ── 장면 구간 ──
const S0 = [0, 5] as const;
const S1 = [5, 11] as const;
const S2 = [11, 18] as const;
const S3 = [18, 25] as const;
const S4 = [25, 30] as const;
const OUT = (s: readonly [number, number]) => s[1] - 0.35; // 장면 끝 0.35초 전부터 퇴장

const P = PAL;

// 공통 요소
const badge = (id: string, label: string, s: readonly [number, number]): { sp: Sprite; tx: TextItem } => ({
  sp: { id: `${id}_badge`, x: 270, y: 120, w: 180, h: 64, tin: s[0] + 0.1, tout: OUT(s), dx: 0, dy: -16, bob: 0, prims: [{ k: 'rect', x: 0, y: 0, w: 180, h: 64, r: 32, c: P.teal }] },
  tx: { id: `${id}_badge_t`, text: label, size: 30, c: P.white, x: -1, y: 134, maxW: 150, tin: s[0] + 0.1, tout: OUT(s), dy: -16 },
});

const captionCard = (id: string, s: readonly [number, number]): Sprite => ({
  id: `${id}_cap`, x: 40, y: 968, w: 640, h: 176, tin: s[0] + 0.6, tout: OUT(s), dx: 0, dy: 24, bob: 0,
  prims: [
    { k: 'rect', x: 0, y: 8, w: 640, h: 168, r: 28, c: P.navy, o: 10 },
    { k: 'rect', x: 0, y: 0, w: 640, h: 168, r: 28, c: P.white },
    { k: 'rect', x: 28, y: 30, w: 8, h: 108, r: 4, c: P.teal },
  ],
});

const caption = (id: string, s: readonly [number, number], l1: string, l2: string): TextItem[] => [
  { id: `${id}_c1`, text: l1, size: 34, c: P.ink, x: 96, y: 1006, maxW: 560, tin: s[0] + 0.7, tout: OUT(s), dy: 24 },
  { id: `${id}_c2`, text: l2, size: 34, c: P.ink, x: 96, y: 1060, maxW: 560, tin: s[0] + 0.7, tout: OUT(s), dy: 24 },
];

const headline = (id: string, s: readonly [number, number], lines: readonly string[], y0: number, size = 52): TextItem[] =>
  lines.map((t, i) => ({ id: `${id}_h${i}`, text: t, size, c: P.navy, x: -1, y: y0 + i * Math.round(size * 1.38), maxW: 640, tin: s[0] + 0.25 + i * 0.12, tout: OUT(s), dy: 18 }));

// ── 장면 0: 도입 (사은품 숫자) ──
const gift: Sprite = {
  id: 's0_gift', x: 170, y: 540, w: 380, h: 420, tin: 0.5, tout: OUT(S0), dx: 0, dy: 40, bob: 0,
  prims: [
    { k: 'rect', x: 30, y: 392, w: 320, h: 22, r: 11, c: P.navy, o: 8 },
    { k: 'rect', x: 40, y: 170, w: 300, h: 220, r: 22, c: P.coral },
    { k: 'rect', x: 20, y: 120, w: 340, h: 70, r: 18, c: P.coralDark },
    { k: 'rect', x: 165, y: 120, w: 50, h: 270, r: 6, c: P.sun },
    { k: 'ring', cx: 150, cy: 92, r: 40, t: 20, c: P.sun },
    { k: 'ring', cx: 230, cy: 92, r: 40, t: 20, c: P.sun },
    { k: 'circle', cx: 190, cy: 118, r: 22, c: P.sun },
    { k: 'rect', x: 40, y: 170, w: 300, h: 16, r: 0, c: P.navy, o: 12 },
  ],
};
const tag: Sprite = {
  id: 's0_tag', x: 410, y: 500, w: 200, h: 170, tin: 1.2, tout: OUT(S0), dx: 30, dy: -10, bob: 0,
  prims: [
    { k: 'line', x1: 20, y1: 150, x2: 70, y2: 96, t: 4, c: P.navySoft },
    { k: 'rect', x: 56, y: 14, w: 132, h: 96, r: 20, c: P.navy, o: 10 },
    { k: 'rect', x: 52, y: 8, w: 132, h: 96, r: 20, c: P.white },
    { k: 'outline', x: 52, y: 8, w: 132, h: 96, r: 20, t: 4, c: P.line },
    { k: 'circle', cx: 74, cy: 30, r: 7, c: P.line },
  ],
};

// ── 장면 1: 월 요금 + 약정 기간 ──
const billCard: Sprite = {
  id: 's1_card', x: 90, y: 470, w: 540, h: 360, tin: S1[0] + 0.4, tout: OUT(S1), dx: 0, dy: 40, bob: 0,
  prims: [
    { k: 'rect', x: 0, y: 12, w: 540, h: 340, r: 32, c: P.navy, o: 9 },
    { k: 'rect', x: 0, y: 0, w: 540, h: 340, r: 32, c: P.white },
    // 1행: 요금 아이콘(지폐)
    { k: 'circle', cx: 84, cy: 96, r: 44, c: P.tealSoft },
    { k: 'rect', x: 56, y: 78, w: 56, h: 36, r: 6, c: P.teal },
    { k: 'circle', cx: 84, cy: 96, r: 9, c: P.white },
    { k: 'rect', x: 330, y: 84, w: 170, h: 24, r: 12, c: P.line },
    // 구분선
    { k: 'rect', x: 40, y: 168, w: 460, h: 3, r: 1, c: P.line },
    // 2행: 달력 아이콘
    { k: 'circle', cx: 84, cy: 244, r: 44, c: P.coralSoft },
    { k: 'rect', x: 60, y: 222, w: 48, h: 46, r: 8, c: P.coral },
    { k: 'rect', x: 66, y: 236, w: 36, h: 26, r: 4, c: P.white },
    { k: 'line', x1: 72, y1: 216, x2: 72, y2: 228, t: 4, c: P.navy },
    { k: 'line', x1: 96, y1: 216, x2: 96, y2: 228, t: 4, c: P.navy },
    { k: 'rect', x: 330, y: 232, w: 170, h: 24, r: 12, c: P.line },
  ],
};
const billHighlight: Sprite = {
  id: 's1_hl', x: 70, y: 450, w: 580, h: 400, tin: S1[0] + 2.6, tout: OUT(S1), dx: 0, dy: 0, bob: 0,
  prims: [{ k: 'outline', x: 6, y: 6, w: 568, h: 388, r: 40, t: 8, c: P.teal }],
};
const plusChip: Sprite = {
  id: 's1_chip', x: 230, y: 862, w: 260, h: 64, tin: S1[0] + 2.9, tout: OUT(S1), dx: 0, dy: 16, bob: 0,
  prims: [{ k: 'rect', x: 0, y: 0, w: 260, h: 64, r: 32, c: P.navy }],
};

// ── 장면 2: 기기·이용 방식 ──
const tv: Sprite = {
  id: 's2_tv', x: 40, y: 430, w: 200, h: 180, tin: S2[0] + 0.4, tout: OUT(S2), dx: 0, dy: -30, bob: 0,
  prims: [
    { k: 'rect', x: 10, y: 10, w: 180, h: 118, r: 14, c: P.navy },
    { k: 'rect', x: 22, y: 22, w: 156, h: 94, r: 8, c: P.screen },
    { k: 'rect', x: 34, y: 34, w: 60, h: 10, r: 5, c: P.white, o: 80 },
    { k: 'line', x1: 100, y1: 128, x2: 100, y2: 150, t: 10, c: P.navy },
    { k: 'rect', x: 56, y: 148, w: 88, h: 14, r: 7, c: P.navy },
  ],
};
const laptop: Sprite = {
  id: 's2_laptop', x: 260, y: 430, w: 200, h: 180, tin: S2[0] + 0.7, tout: OUT(S2), dx: 0, dy: -30, bob: 0,
  prims: [
    { k: 'rect', x: 30, y: 20, w: 140, h: 100, r: 12, c: P.navy },
    { k: 'rect', x: 40, y: 30, w: 120, h: 80, r: 6, c: P.screen },
    { k: 'rect', x: 50, y: 40, w: 50, h: 9, r: 4, c: P.white, o: 80 },
    { k: 'rect', x: 10, y: 122, w: 180, h: 20, r: 10, c: P.navySoft },
    { k: 'rect', x: 80, y: 122, w: 40, h: 7, r: 3, c: P.navy },
  ],
};
const phone: Sprite = {
  id: 's2_phone', x: 480, y: 430, w: 200, h: 180, tin: S2[0] + 1.0, tout: OUT(S2), dx: 0, dy: -30, bob: 0,
  prims: [
    { k: 'rect', x: 62, y: 6, w: 76, h: 146, r: 16, c: P.navy },
    { k: 'rect', x: 70, y: 20, w: 60, h: 112, r: 8, c: P.screen },
    { k: 'rect', x: 88, y: 11, w: 24, h: 5, r: 2, c: P.navySoft },
    { k: 'rect', x: 78, y: 30, w: 30, h: 8, r: 4, c: P.white, o: 80 },
  ],
};
const router: Sprite = {
  id: 's2_router', x: 160, y: 640, w: 400, h: 300, tin: S2[0] + 1.6, tout: OUT(S2), dx: 0, dy: 30, bob: 0,
  prims: [
    { k: 'line', x1: 120, y1: 200, x2: 104, y2: 150, t: 10, c: P.navy },
    { k: 'line', x1: 280, y1: 200, x2: 296, y2: 150, t: 10, c: P.navy },
    { k: 'rect', x: 80, y: 196, w: 240, h: 76, r: 22, c: P.navy },
    { k: 'circle', cx: 140, cy: 234, r: 8, c: P.teal },
    { k: 'circle', cx: 172, cy: 234, r: 8, c: P.teal },
    { k: 'circle', cx: 204, cy: 234, r: 8, c: P.sun },
    { k: 'rect', x: 236, y: 228, w: 60, h: 12, r: 6, c: P.navySoft },
    { k: 'rect', x: 100, y: 272, w: 200, h: 14, r: 7, c: P.navy, o: 10 },
  ],
};
const wifi = (i: number): Sprite => ({
  id: `s2_wifi${i}`, x: 160, y: 640, w: 400, h: 300, tin: S2[0] + 2.2 + i * 0.3, tout: OUT(S2), dx: 0, dy: 0, bob: 0,
  prims: [{ k: 'arc', cx: 200, cy: 170, r: 40 + i * 42, t: 14, c: P.teal }],
});

// ── 장면 3: 설치 체크리스트 ──
const checkCard: Sprite = {
  id: 's3_card', x: 70, y: 470, w: 580, h: 420, tin: S3[0] + 0.4, tout: OUT(S3), dx: 0, dy: 40, bob: 0,
  prims: [
    { k: 'rect', x: 0, y: 12, w: 580, h: 400, r: 32, c: P.navy, o: 9 },
    { k: 'rect', x: 0, y: 0, w: 580, h: 400, r: 32, c: P.white },
    { k: 'ring', cx: 80, cy: 90, r: 28, t: 5, c: P.line },
    { k: 'ring', cx: 80, cy: 210, r: 28, t: 5, c: P.line },
    { k: 'ring', cx: 80, cy: 330, r: 28, t: 5, c: P.line },
    { k: 'rect', x: 40, y: 148, w: 500, h: 3, r: 1, c: P.line },
    { k: 'rect', x: 40, y: 268, w: 500, h: 3, r: 1, c: P.line },
  ],
};
const check = (i: number): Sprite => ({
  id: `s3_check${i}`, x: 70 + 44, y: 470 + 54 + i * 120, w: 72, h: 72, tin: S3[0] + 1.4 + i * 0.9, tout: OUT(S3), dx: 0, dy: 0, bob: 0,
  prims: [
    { k: 'circle', cx: 36, cy: 36, r: 30, c: P.teal },
    { k: 'line', x1: 23, y1: 37, x2: 32, y2: 46, t: 6, c: P.white },
    { k: 'line', x1: 32, y1: 46, x2: 50, y2: 27, t: 6, c: P.white },
  ],
});
const calendar: Sprite = {
  id: 's3_cal', x: 500, y: 380, w: 180, h: 170, tin: S3[0] + 0.9, tout: OUT(S3), dx: 20, dy: -20, bob: 0,
  prims: [
    { k: 'rect', x: 18, y: 32, w: 150, h: 130, r: 20, c: P.navy, o: 10 },
    { k: 'rect', x: 14, y: 24, w: 150, h: 130, r: 20, c: P.white },
    { k: 'outline', x: 14, y: 24, w: 150, h: 130, r: 20, t: 4, c: P.line },
    { k: 'rect', x: 14, y: 24, w: 150, h: 40, r: 20, c: P.coral },
    { k: 'rect', x: 14, y: 44, w: 150, h: 20, r: 0, c: P.coral },
    { k: 'line', x1: 52, y1: 12, x2: 52, y2: 36, t: 8, c: P.navy },
    { k: 'line', x1: 126, y1: 12, x2: 126, y2: 36, t: 8, c: P.navy },
    { k: 'circle', cx: 50, cy: 92, r: 8, c: P.line },
    { k: 'circle', cx: 89, cy: 92, r: 8, c: P.line },
    { k: 'circle', cx: 128, cy: 92, r: 8, c: P.line },
    { k: 'circle', cx: 50, cy: 126, r: 8, c: P.line },
    { k: 'circle', cx: 89, cy: 126, r: 14, c: P.teal },
    { k: 'circle', cx: 128, cy: 126, r: 8, c: P.line },
  ],
};

// ── 장면 4: 마무리 ──
const underline: Sprite = {
  id: 's4_bar', x: 230, y: 640, w: 260, h: 16, tin: S4[0] + 0.6, tout: 30, dx: -40, dy: 0, bob: 0,
  prims: [{ k: 'rect', x: 0, y: 0, w: 260, h: 16, r: 8, c: P.teal }],
};
const routerMini: Sprite = {
  id: 's4_mark', x: 300, y: 330, w: 120, h: 110, tin: S4[0] + 0.2, tout: 30, dx: 0, dy: 20, bob: 0,
  prims: [
    { k: 'arc', cx: 60, cy: 70, r: 22, t: 9, c: P.teal },
    { k: 'arc', cx: 60, cy: 70, r: 44, t: 9, c: P.teal },
    { k: 'circle', cx: 60, cy: 82, r: 9, c: P.navy },
  ],
};

const b1 = badge('s1', '체크 1', S1);
const b2 = badge('s2', '체크 2', S2);
const b3 = badge('s3', '체크 3', S3);


/** 깊은 동결: 승인 대본·도형·좌표 원본을 같은 프로세스 안에서도 바꿀 수 없게 한다(PM 6984125979 4절) */
function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
    Object.freeze(v);
  }
  return v;
}

export const EXPLAINER_PLAN: ExplainerPlan = deepFreeze({
  variant: EX_VARIANT,
  sprites: [
    gift, tag,
    b1.sp, billCard, billHighlight, plusChip, captionCard('s1', S1),
    b2.sp, tv, laptop, phone, router, wifi(0), wifi(1), wifi(2), captionCard('s2', S2),
    b3.sp, checkCard, calendar, check(0), check(1), check(2), captionCard('s3', S3),
    routerMini, underline,
  ],
  texts: [
    { id: 's0_pre', text: '인터넷 바꿀 때,', size: 40, c: P.muted, x: -1, y: 196, maxW: 600, tin: 0.2, tout: OUT(S0), dy: 14 },
    ...headline('s0', S0, ['사은품 숫자만 보고', '결정하시나요?'], 262, 60),
    { id: 's0_q', text: '?', size: 64, c: P.coral, x: 515, y: 530, maxW: 80, tin: 1.2, tout: OUT(S0), dy: -10 },

    b1.tx,
    ...headline('s1', S1, ['월 요금과 약정 기간,', '함께 보세요'], 224),
    { id: 's1_r1', text: '월 요금', size: 40, c: P.ink, x: 230, y: 544, maxW: 180, tin: S1[0] + 0.9, tout: OUT(S1), dy: 0 },
    { id: 's1_r2', text: '약정 기간', size: 40, c: P.ink, x: 230, y: 692, maxW: 180, tin: S1[0] + 1.5, tout: OUT(S1), dy: 0 },
    { id: 's1_chip_t', text: '같이 비교하기', size: 30, c: P.white, x: -1, y: 876, maxW: 230, tin: S1[0] + 2.9, tout: OUT(S1), dy: 16 },
    ...caption('s1', S1, '첫째, 매달 내는 요금과', '약정 기간을 함께 보세요.'),

    b2.tx,
    ...headline('s2', S2, ['우리 집 기기와 이용 방식에', '맞는 속도를 고르세요'], 224, 48),
    { id: 's2_l1', text: 'TV', size: 28, c: P.muted, x: 118, y: 606, maxW: 120, tin: S2[0] + 0.4, tout: OUT(S2), dy: -30 },
    { id: 's2_l2', text: '노트북', size: 28, c: P.muted, x: 318, y: 606, maxW: 120, tin: S2[0] + 0.7, tout: OUT(S2), dy: -30 },
    { id: 's2_l3', text: '휴대폰', size: 28, c: P.muted, x: 538, y: 606, maxW: 120, tin: S2[0] + 1.0, tout: OUT(S2), dy: -30 },
    ...caption('s2', S2, '둘째, 집에서 쓰는 기기와 이용', '방식에 맞는 속도를 고르세요.'),

    b3.tx,
    ...headline('s3', S3, ['설치비·설치 가능 여부,', '희망 일정까지'], 224),
    { id: 's3_r1', text: '설치비', size: 40, c: P.ink, x: 200, y: 538, maxW: 300, tin: S3[0] + 0.7, tout: OUT(S3), dy: 0 },
    { id: 's3_r2', text: '설치 가능 여부', size: 40, c: P.ink, x: 200, y: 658, maxW: 300, tin: S3[0] + 0.8, tout: OUT(S3), dy: 0 },
    { id: 's3_r3', text: '희망 일정', size: 40, c: P.ink, x: 200, y: 778, maxW: 300, tin: S3[0] + 0.9, tout: OUT(S3), dy: 0 },
    ...caption('s3', S3, '셋째, 설치비와 설치 가능 여부,', '희망 일정도 확인하세요.'),

    { id: 's4_brand', text: '바른365', size: 112, c: P.navy, x: -1, y: 476, maxW: 600, tin: S4[0] + 0.3, tout: 30, dy: 20 },
    { id: 's4_l1', text: '인터넷·TV,', size: 44, c: P.ink, x: -1, y: 724, maxW: 600, tin: S4[0] + 1.0, tout: 30, dy: 16 },
    { id: 's4_l2', text: '나에게 맞는 조건부터', size: 44, c: P.ink, x: -1, y: 786, maxW: 600, tin: S4[0] + 1.15, tout: 30, dy: 16 },
    { id: 's4_l3', text: '꼼꼼하게', size: 44, c: P.teal, x: -1, y: 848, maxW: 600, tin: S4[0] + 1.3, tout: 30, dy: 16 },
  ],
});

// ── 검증 (불신 입력 취급) ──
const COLOR_RE = /^0x[0-9a-f]{6}$/;
const ID_RE = /^[a-z0-9_]{1,24}$/;
/** 화면 문구 허용 문자: 한글·영숫자·공백·쉼표·마침표·물음표·가운뎃점 */
export const TEXT_RE = /^[가-힣A-Za-z0-9 ,.?·]{1,24}$/;
const MAX_SPRITES = 40;
const MAX_PRIMS = 16;
const MAX_TEXTS = 48;

const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= lo && v <= hi;
/** 시간: 0~30초, 소수 둘째 자리까지 */
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= EX_DURATION_SEC && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
const plain = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
};
/** 데이터 속성만(접근자 거부) 한 번 읽기 */
function snap(v: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> | null {
  if (!plain(v)) return null;
  const own = Object.keys(v);
  if (!own.every((k) => keys.includes(k) || optional.includes(k))) return null;
  if (!keys.every((k) => own.includes(k))) return null;
  const out: Record<string, unknown> = {};
  for (const k of own) {
    const d = Object.getOwnPropertyDescriptor(v, k);
    if (!d || !('value' in d)) return null;
    out[k] = d.value;
  }
  return out;
}

const PRIM_KEYS: Record<Prim['k'], readonly string[]> = {
  rect: ['k', 'x', 'y', 'w', 'h', 'r', 'c'],
  outline: ['k', 'x', 'y', 'w', 'h', 'r', 't', 'c'],
  circle: ['k', 'cx', 'cy', 'r', 'c'],
  ring: ['k', 'cx', 'cy', 'r', 't', 'c'],
  line: ['k', 'x1', 'y1', 'x2', 'y2', 't', 'c'],
  arc: ['k', 'cx', 'cy', 'r', 't', 'c'],
};

function checkPrim(v: unknown, w: number, h: number): Prim | null {
  const k = plain(v) ? Object.getOwnPropertyDescriptor(v, 'k')?.value : undefined;
  if (typeof k !== 'string' || !(k in PRIM_KEYS)) return null;
  const s = snap(v, PRIM_KEYS[k as Prim['k']], ['o']);
  if (!s) return null;
  if (typeof s.c !== 'string' || !COLOR_RE.test(s.c)) return null;
  if ('o' in s && !isInt(s.o, 1, 100)) return null;
  const nums = PRIM_KEYS[k as Prim['k']].filter((x) => x !== 'k' && x !== 'c');
  const span = Math.max(w, h);
  for (const n of nums) if (!isInt(s[n], -span, span * 2)) return null;
  if ((k === 'rect' || k === 'outline') && !((s.w as number) > 0 && (s.h as number) > 0 && (s.r as number) >= 0 && (s.r as number) * 2 <= Math.min(s.w as number, s.h as number))) return null;
  if ('t' in s && !((s.t as number) >= 1 && (s.t as number) <= 40)) return null;
  if ((k === 'circle' || k === 'ring' || k === 'arc') && !((s.r as number) >= 1)) return null;
  return Object.freeze(s) as unknown as Prim;
}

function checkSprite(v: unknown): Sprite | null {
  const s = snap(v, ['id', 'x', 'y', 'w', 'h', 'tin', 'tout', 'dx', 'dy', 'bob', 'prims']);
  if (!s) return null;
  if (typeof s.id !== 'string' || !ID_RE.test(s.id)) return null;
  if (!isInt(s.w, 8, EX_WIDTH) || !isInt(s.h, 8, EX_HEIGHT)) return null;
  if (!isInt(s.x, 0, EX_WIDTH - s.w) || !isInt(s.y, 0, EX_HEIGHT - s.h)) return null;
  if (!isTime(s.tin) || !isTime(s.tout) || !(s.tout - s.tin >= 0.5)) return null;
  if (!isInt(s.dx, -120, 120) || !isInt(s.dy, -120, 120) || !isInt(s.bob, 0, 12)) return null;
  // 이동 중에도 화면 밖으로 나가지 않는다
  if (s.x + Math.min(0, s.dx) < 0 || s.x + s.w + Math.max(0, s.dx) > EX_WIDTH) return null;
  if (s.y + Math.min(0, s.dy) - s.bob < 0 || s.y + s.h + Math.max(0, s.dy) + s.bob > EX_HEIGHT) return null;
  if (!Array.isArray(s.prims) || s.prims.length < 1 || s.prims.length > MAX_PRIMS) return null;
  const prims: Prim[] = [];
  for (let i = 0; i < s.prims.length; i++) {
    const d = Object.getOwnPropertyDescriptor(s.prims, i);
    if (!d || !('value' in d)) return null;
    const p = checkPrim(d.value, s.w, s.h);
    if (!p) return null;
    prims.push(p);
  }
  return Object.freeze({ ...(s as Omit<Sprite, 'prims'>), prims: Object.freeze(prims) });
}

function checkText(v: unknown): TextItem | null {
  const s = snap(v, ['id', 'text', 'size', 'c', 'x', 'y', 'maxW', 'tin', 'tout', 'dy']);
  if (!s) return null;
  if (typeof s.id !== 'string' || !ID_RE.test(s.id)) return null;
  if (typeof s.text !== 'string' || !TEXT_RE.test(s.text) || s.text !== s.text.trim()) return null;
  if (!isInt(s.size, 20, 128) || typeof s.c !== 'string' || !COLOR_RE.test(s.c)) return null;
  if (!(s.x === -1 || isInt(s.x, 0, EX_WIDTH - 1))) return null;
  if (!isInt(s.maxW, 20, EX_WIDTH - 40)) return null;
  if (s.x !== -1 && (s.x as number) + (s.maxW as number) > EX_WIDTH) return null;
  if (!isInt(s.dy, -120, 120)) return null;
  if (!isInt(s.y, 0, EX_HEIGHT - (s.size as number) * 2) || (s.y as number) + Math.min(0, s.dy as number) < 0) return null;
  if (!isTime(s.tin) || !isTime(s.tout) || !(s.tout - s.tin >= 0.5)) return null;
  return Object.freeze(s) as unknown as TextItem;
}

export type PlanCheck = { readonly ok: true; readonly plan: ExplainerPlan } | { readonly ok: false; readonly error: 'INVALID_PLAN' };

/** 계획 검증(순수). 통과하면 동결 스냅샷 */
export function validateExplainerPlan(v: unknown): PlanCheck {
  try {
    const s = snap(v, ['variant', 'sprites', 'texts']);
    if (!s || s.variant !== EX_VARIANT || !Array.isArray(s.sprites) || !Array.isArray(s.texts)) return { ok: false, error: 'INVALID_PLAN' };
    if (s.sprites.length < 1 || s.sprites.length > MAX_SPRITES || s.texts.length < 1 || s.texts.length > MAX_TEXTS) return { ok: false, error: 'INVALID_PLAN' };
    const ids = new Set<string>();
    const sprites: Sprite[] = [];
    for (let i = 0; i < s.sprites.length; i++) {
      const d = Object.getOwnPropertyDescriptor(s.sprites, i);
      const sp = d && 'value' in d ? checkSprite(d.value) : null;
      if (!sp || ids.has(sp.id)) return { ok: false, error: 'INVALID_PLAN' };
      ids.add(sp.id);
      sprites.push(sp);
    }
    const texts: TextItem[] = [];
    for (let i = 0; i < s.texts.length; i++) {
      const d = Object.getOwnPropertyDescriptor(s.texts, i);
      const tx = d && 'value' in d ? checkText(d.value) : null;
      if (!tx || ids.has(tx.id)) return { ok: false, error: 'INVALID_PLAN' };
      ids.add(tx.id);
      texts.push(tx);
    }
    return { ok: true, plan: Object.freeze({ variant: EX_VARIANT, sprites: Object.freeze(sprites), texts: Object.freeze(texts) }) };
  } catch {
    return { ok: false, error: 'INVALID_PLAN' };
  }
}

/** 공개 입력: 정확히 { variant: 'general_internet_v1' } */
export function buildExplainerStoryboard(input: unknown): PlanCheck | { readonly ok: false; readonly error: 'INVALID_INPUT' } {
  try {
    const s = snap(input, ['variant']);
    if (!s || s.variant !== EX_VARIANT) return { ok: false, error: 'INVALID_INPUT' };
  } catch {
    // Proxy 트랩·접근자 예외 등은 원문 없이 고정 오류
    return { ok: false, error: 'INVALID_INPUT' };
  }
  return validateExplainerPlan(EXPLAINER_PLAN);
}
