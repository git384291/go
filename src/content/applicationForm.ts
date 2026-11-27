/**
 * 총판 전달용 신청서 항목(PM 11/22: 실제 총판 전달 양식 순서에 맞춤). 브라우저·서버 공용 순수 모듈(비밀·외부 호출 없음).
 * - 고객에게서 받는 항목은 아래 APPLICATION_FIELDS뿐이다. AI 모델은 이 값을 보지 못한다(질문은 정해진 문장, 답은 검증된 구조 값으로 서버에 바로 저장).
 * - 주민번호·자동이체·사은품계좌는 어떤 경로로도 받지 않는다: 형식이 닿으면 저장 전에 거부하고, 신청서에는 "총판 별도 확인"으로 표시한다.
 * - 기존회선 12개월 유지 안내·약정 3년 및 설치비 안내의 '안내 문구'는 총판 확정 전이라 이 모듈에 쓰지 않는다. 고객은 "확인함"만 표시한다.
 */
export type Option = { readonly value: string; readonly label: string };
export type FieldKey =
  | 'installAddress' | 'phoneCarrier' | 'email' | 'currentCarrier' | 'installPref' | 'installDate' | 'existingLine' | 'ack12m' | 'ackContract3y'
  | 'housingType' | 'subscriberType' | 'tvCount' | 'memo';
export type FieldDef = {
  readonly key: FieldKey;
  readonly label: string;
  readonly question: string;
  readonly kind: 'select' | 'text';
  readonly required: boolean;
  readonly options?: readonly Option[];
  readonly min?: number;
  readonly max?: number;
};

const CONFIRMED: readonly Option[] = [{ value: 'confirmed', label: '확인했습니다' }];

/** 질문 순서. 필수 항목이 먼저 차례로 나오고(installDate는 '희망일 지정'을 고른 때만), 선택 항목은 그 뒤에 묻는다 */
export const APPLICATION_FIELDS: readonly FieldDef[] = Object.freeze([
  { key: 'installAddress', label: '설치주소', question: '설치하실 곳의 주소를 알려 주세요. (동·호수까지)', kind: 'text', required: true, min: 5, max: 100 },
  { key: 'phoneCarrier', label: '휴대폰 통신사', question: '연락받으실 휴대폰의 통신사는 어디인가요?', kind: 'select', required: true, options: [
    { value: 'skt', label: 'SKT' }, { value: 'kt', label: 'KT' }, { value: 'lgu', label: 'LG U+' }, { value: 'mvno', label: '알뜰폰' }] },
  { key: 'email', label: '이메일', question: '이메일 주소를 알려 주세요.', kind: 'text', required: true, min: 6, max: 80 },
  { key: 'currentCarrier', label: '이전통신사', question: '지금 쓰고 계신 인터넷은 어느 통신사인가요?', kind: 'select', required: true, options: [
    { value: 'kt', label: 'KT' }, { value: 'skb', label: 'SK브로드밴드' }, { value: 'lgu', label: 'LG U+' }, { value: 'cable', label: '케이블 등 기타' }, { value: 'none', label: '이용 안 함' }] },
  { key: 'installPref', label: '설치희망일 / 빠른 날짜', question: '설치는 빠른 날짜로 할까요, 원하는 날짜가 있으신가요?', kind: 'select', required: true, options: [
    { value: 'asap', label: '빠른 날짜' }, { value: 'date', label: '희망일 지정' }] },
  { key: 'installDate', label: '설치 희망일', question: '원하시는 설치 날짜를 입력해 주세요. (예: 2026-12-05)', kind: 'text', required: false, min: 10, max: 10 },
  { key: 'existingLine', label: '기존회선 확인', question: '지금 쓰고 계신 기존 인터넷 회선이 있나요?', kind: 'select', required: true, options: [
    { value: 'has', label: '기존 회선 있음' }, { value: 'none', label: '기존 회선 없음' }] },
  { key: 'ack12m', label: '기존회선 12개월 유지 안내', question: '기존회선 12개월 유지 안내를 확인하셨나요? (안내 문구는 총판 확정 후 적용)', kind: 'select', required: true, options: CONFIRMED },
  { key: 'ackContract3y', label: '약정 3년 및 설치비 안내·확인', question: '약정 3년 및 설치비 안내를 확인하셨나요? (안내 문구는 총판 확정 후 적용)', kind: 'select', required: true, options: CONFIRMED },
  { key: 'housingType', label: '주거 형태(참고)', question: '설치하실 곳은 어떤 형태인가요? (선택)', kind: 'select', required: false, options: [
    { value: 'apartment', label: '아파트' }, { value: 'villa', label: '빌라·다세대' }, { value: 'house', label: '단독·다가구' }, { value: 'officetel', label: '오피스텔' }, { value: 'other', label: '기타' }] },
  { key: 'subscriberType', label: '가입 명의(참고)', question: '가입 명의는 누구로 하실 예정인가요? (선택)', kind: 'select', required: false, options: [
    { value: 'self', label: '본인' }, { value: 'family', label: '가족' }, { value: 'business', label: '사업자' }] },
  { key: 'tvCount', label: 'TV 대수', question: '설치할 TV는 몇 대인가요? (선택)', kind: 'select', required: false, options: [
    { value: '1', label: '1대' }, { value: '2', label: '2대' }, { value: '3plus', label: '3대 이상' }] },
  { key: 'memo', label: '전달 메모', question: '총판에 전달할 말이 있으면 적어 주세요. (선택, 100자 이내)', kind: 'text', required: false, max: 100 },
]);

/** 상담 화면이 서버 설정으로 고정한 상품 선택(고객이 바꿀 수 없음). 코드 형식만 허용 */
export const CHOICE_KEYS = ['carrier', 'productId', 'regionCode'] as const;
const CHOICE_LABEL: Record<(typeof CHOICE_KEYS)[number], string> = { carrier: '가입 통신사', productId: '신청상품', regionCode: '지역' };
const CODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const EMAIL = /^[A-Za-z0-9._%+-]{1,40}@[A-Za-z0-9.-]{1,35}\.[A-Za-z]{2,10}$/;

export type Application = { carrier?: string; productId?: string; regionCode?: string } & { [K in FieldKey]?: string };

/** AI 상담·신청서 어디서도 받지 않는 항목: 총판이 별도로 확인한다(PM 11/22: 주민번호·자동이체·사은품계좌) */
export const DEALER_ONLY_ITEMS: readonly { readonly key: string; readonly label: string; readonly note: string }[] = Object.freeze([
  { key: 'rrn', label: '주민번호', note: '총판 별도 확인' },
  { key: 'autopay', label: '자동이체', note: '총판 별도 확인' },
  { key: 'gift_account', label: '사은품계좌', note: '총판 별도 확인' },
]);

/** 민감정보(주민번호·계좌·카드·비밀번호) 형식·표현. 닿으면 사유 코드만 돌려준다(값은 남기지 않는다) */
export function sensitiveReason(text: string): 'RRN' | 'CARD' | 'ACCOUNT' | 'KEYWORD' | null {
  if (/\d{6}\s*-?\s*[1-8]\d{6}/.test(text)) return 'RRN';
  if (/\d{4}[-\s]\d{4}[-\s]\d{4}[-\s]\d{3,4}/.test(text)) return 'CARD';
  if (/\d{3,}\s*-\s*\d{2,}\s*-\s*\d{4,}/.test(text) || /\d{10,}/.test(text)) return 'ACCOUNT';
  if (/주민\s*(등록)?\s*번호|계좌|통장|자동\s*이체|카드\s*번호|비밀\s*번호|CVC|CVV/i.test(text)) return 'KEYWORD';
  return null;
}

export type ValidateResult = { readonly ok: true; readonly value: Application } | { readonly ok: false; readonly code: 'APPLICATION_INVALID' | 'SENSITIVE_INPUT' };

const validDate = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
};

/** 신청서 본문 검증: 알려진 키만, 문자열만, 선택값은 목록 안, 글은 길이·형식·민감정보 검사. 일부 항목만 있어도 통과(누락은 별도 점검) */
export function validateApplication(input: unknown): ValidateResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, code: 'APPLICATION_INVALID' };
  const o = input as Record<string, unknown>;
  const known = new Set<string>([...CHOICE_KEYS, ...APPLICATION_FIELDS.map((f) => f.key)]);
  const out: Application = {};
  for (const [k, v] of Object.entries(o)) {
    if (!known.has(k) || typeof v !== 'string') return { ok: false, code: 'APPLICATION_INVALID' };
    if ((CHOICE_KEYS as readonly string[]).includes(k)) {
      if (!CODE.test(v)) return { ok: false, code: 'APPLICATION_INVALID' };
      (out as Record<string, string>)[k] = v; continue;
    }
    const def = APPLICATION_FIELDS.find((f) => f.key === k)!;
    const val = v.trim();
    if (val === '') continue; // 빈 값은 '없음'과 같다
    if (def.kind === 'select') {
      if (!def.options!.some((x) => x.value === val)) return { ok: false, code: 'APPLICATION_INVALID' };
    } else {
      if (val.length > (def.max ?? 100) || /[\u0000-\u001f\u007f]/.test(val)) return { ok: false, code: 'APPLICATION_INVALID' };
      if (def.min && val.length < def.min) return { ok: false, code: 'APPLICATION_INVALID' };
      if (k === 'email' && !EMAIL.test(val)) return { ok: false, code: 'APPLICATION_INVALID' };
      if (k === 'installDate' && !validDate(val)) return { ok: false, code: 'APPLICATION_INVALID' };
      if (sensitiveReason(val)) return { ok: false, code: 'SENSITIVE_INPUT' };
    }
    (out as Record<string, string>)[k] = val;
  }
  return { ok: true, value: out };
}

/** 지금 이 답 조합에서 물어야 하는(필수인) 항목. installDate는 '희망일 지정'을 고른 때만 필수 */
export const isNeeded = (f: FieldDef, a: Application | null): boolean => f.required || (f.key === 'installDate' && a?.installPref === 'date');
export const neededFields = (a: Application | null): FieldDef[] => APPLICATION_FIELDS.filter((f) => isNeeded(f, a));

/** 누락된 필수 항목 키(상품 선택 3개 + 고객 필수 항목). 신청서가 없으면 전부 누락 */
export function missingApplication(app: Application | null): string[] {
  const a = (app ?? {}) as Record<string, string | undefined>;
  return [...CHOICE_KEYS.filter((k) => !a[k]), ...neededFields(app).filter((f) => !a[f.key]).map((f) => f.key)];
}
export const labelOf = (key: string): string => CHOICE_LABEL[key as keyof typeof CHOICE_LABEL] ?? APPLICATION_FIELDS.find((f) => f.key === key)?.label ?? key;

/** 다음에 물을 항목(필수 먼저, 그 다음 선택). 모두 끝났으면 null. 빠진 일반 접수정보는 이 순서로 고객에게 자동으로 다시 묻는다 */
export function nextQuestion(app: Application | null): FieldDef | null {
  const a = (app ?? {}) as Record<string, string | undefined>;
  return neededFields(app).find((f) => !a[f.key]) ?? APPLICATION_FIELDS.find((f) => !f.required && f.key !== 'installDate' && !a[f.key]) ?? null;
}

/** DB에 평문으로 두는 요약(개인정보 아님: 범주형 선택값·누락 목록만. 주소·이메일·메모는 암호화 본문에만) */
export function applicationSummary(app: Application): { answered: number; missing: string[]; carrier?: string; productId?: string; regionCode?: string; currentCarrier?: string; installPref?: string; existingLine?: string } {
  const miss = missingApplication(app);
  const pick = (k: keyof Application) => (app[k] ? { [k]: app[k] } : {});
  return { answered: Object.values(app).filter(Boolean).length, missing: miss, ...pick('carrier'), ...pick('productId'), ...pick('regionCode'), ...pick('currentCarrier'), ...pick('installPref'), ...pick('existingLine') };
}

export type PacketQuote = {
  readonly kind: 'quote' | 'needs_review';
  readonly text: string;
  /** 승인·게시 정책이 통과한 경우에만 있다. 정책 밖 금액은 들어오지 않는다 */
  readonly fields?: { readonly productLabel: string; readonly monthlyFee: string; readonly installFee: string; readonly gift: string };
};
export type PacketInput = {
  readonly lead: { readonly name: string; readonly phone: string; readonly interest: string; readonly contactTime: string | null; readonly createdAt: string };
  readonly app: Application | null;
  readonly quote: PacketQuote | null;
  /** 필수 고지 확인 완료 여부(서버가 고지 확정 상태·고객별 노출 기록으로 판정). false면 '준비 완료'를 만들지 않는다 */
  readonly noticeReady: boolean;
  readonly generatedAt: string;
};
export type PacketItem = { readonly label: string; readonly value: string; readonly kind: 'value' | 'dealer_only' | 'missing' };
export type Packet = {
  /** ready=전달 준비 완료 · incomplete=고객 정보 누락 · notice_pending=필수 고지 확인 미완료 */
  readonly status: 'ready' | 'incomplete' | 'notice_pending';
  readonly missing: readonly string[];
  readonly missingLabels: readonly string[];
  readonly dealerOnly: readonly { key: string; label: string; note: string }[];
  readonly items: readonly PacketItem[];
  readonly text: string;
};

const OPT = (key: string, v: string | undefined) => (v ? APPLICATION_FIELDS.find((f) => f.key === key)?.options?.find((o) => o.value === v)?.label ?? v : '');
const INTEREST: Record<string, string> = { internet_tv: '인터넷+TV', internet_phone: '인터넷+휴대폰', internet_only: '인터넷', cctv_security: 'CCTV·보안', other: '기타' };
const NONE = '(미입력)';
const DEALER_CHECK = '총판 확인(승인된 정책 안내 없음)';

/** 총판 전달용 자료: 실제 총판 전달 양식의 항목·순서. 문자열만 만든다(저장·전송 없음) */
export function buildDealerPacket(i: PacketInput): Packet {
  const a = (i.app ?? {}) as Record<string, string | undefined>;
  const missing = missingApplication(i.app);
  const q = i.quote?.fields;
  const dealerOnly = DEALER_ONLY_ITEMS.map((d) => ({ ...d }));
  const dealer = (label: string): PacketItem => ({ label, value: '총판 별도 확인', kind: 'dealer_only' });
  const v = (label: string, value: string | undefined): PacketItem => ({ label, value: value && value !== '' ? value : NONE, kind: value && value !== '' ? 'value' : 'missing' });
  const installWhen = a.installPref === 'date' ? (a.installDate ? `희망일 ${a.installDate}` : undefined) : a.installPref === 'asap' ? '빠른 날짜' : undefined;
  const items: PacketItem[] = [
    v('고객명', i.lead.name),
    dealer('주민번호'),
    v('설치주소', a.installAddress),
    v('연락처 / 통신사', a.phoneCarrier ? `${i.lead.phone} / ${OPT('phoneCarrier', a.phoneCarrier)}` : undefined),
    v('이메일', a.email),
    dealer('자동이체'),
    dealer('사은품계좌'),
    v('가입 통신사', a.carrier),
    v('신청상품', q?.productLabel ?? (a.productId ? `${INTEREST[i.lead.interest] ?? i.lead.interest} (상품 코드 ${a.productId})` : undefined)),
    { label: '월요금', value: q?.monthlyFee ?? DEALER_CHECK, kind: q ? 'value' : 'missing' },
    { label: '설치비(기사출동비)', value: q?.installFee ?? DEALER_CHECK, kind: q ? 'value' : 'missing' },
    v('설치희망일 / 빠른 날짜', installWhen),
    { label: '상품권', value: q?.gift ?? DEALER_CHECK, kind: q ? 'value' : 'missing' },
    v('이전통신사', OPT('currentCarrier', a.currentCarrier)),
    v('기타: 기존회선 12개월 유지 안내', a.ack12m === 'confirmed' ? '고객 확인함' : undefined),
    v('기존회선 확인', OPT('existingLine', a.existingLine)),
    v('약정 3년 및 설치비 안내·확인', a.ackContract3y === 'confirmed' ? '고객 확인함' : undefined),
  ];
  const status: Packet['status'] = missing.length > 0 ? 'incomplete' : i.noticeReady ? 'ready' : 'notice_pending';
  const head = status === 'ready' ? '총판 전달 준비 완료' : status === 'incomplete' ? '총판 전달 준비 미완료 — 고객 정보 누락' : '총판 전달 준비 미완료 — 필수 고지 확인 미완료';
  const lines = [`[총판 전달용 신청서] ${head} · 생성 ${i.generatedAt}`, ''];
  for (const it of items) lines.push(`■ ${it.label}: ${it.value}`);
  const ref = [['연락 가능 시간', i.lead.contactTime ?? undefined], ['주거 형태', OPT('housingType', a.housingType)], ['가입 명의(고객 응답)', OPT('subscriberType', a.subscriberType)], ['TV 대수', OPT('tvCount', a.tvCount)], ['전달 메모', a.memo]].filter(([, x]) => x);
  if (ref.length > 0) { lines.push('', '(참고: 고객 입력)'); for (const [k, x] of ref) lines.push(`- ${k}: ${x}`); }
  if (missing.length > 0) lines.push('', `※ 누락 항목: ${missing.map(labelOf).join(', ')}`);
  if (status === 'notice_pending') lines.push('', '※ 필수 고지 확인이 끝나지 않아 전달 준비 완료로 표시하지 않습니다.');
  return { status, missing, missingLabels: missing.map(labelOf), dealerOnly, items, text: lines.join('\n') };
}
