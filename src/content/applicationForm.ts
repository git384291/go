/**
 * 총판 전달용 신청서 항목(PM 11/21). 브라우저·서버 공용 순수 모듈(비밀·외부 호출 없음).
 * - 고객에게서 받는 항목은 아래 APPLICATION_FIELDS뿐이다. AI 모델은 이 값을 보지 못한다(질문은 정해진 문장, 답은 검증된 구조 값으로 서버에 바로 저장).
 * - 주민등록번호·자동이체·계좌정보는 어떤 경로로도 받지 않는다: 형식이 닿으면 저장 전에 거부하고, 신청서에는 "총판 별도 확인"으로 표시한다.
 * - 총판의 실제 접수 양식은 아직 받지 못했다. 이 항목·순서는 내부 정리용이며, 양식이 확정되면 buildDealerPacket의 섹션 매핑만 바꾼다.
 */
export type Option = { readonly value: string; readonly label: string };
export type FieldDef = {
  readonly key: 'installAddress' | 'housingType' | 'subscriberType' | 'currentCarrier' | 'installPref' | 'tvCount' | 'memo';
  readonly label: string;
  readonly question: string;
  readonly kind: 'select' | 'text';
  readonly required: boolean;
  readonly options?: readonly Option[];
  readonly min?: number;
  readonly max?: number;
};

export const APPLICATION_FIELDS: readonly FieldDef[] = Object.freeze([
  { key: 'installAddress', label: '설치 주소', question: '설치하실 곳의 주소를 알려 주세요. (동·호수까지)', kind: 'text', required: true, min: 5, max: 100 },
  { key: 'housingType', label: '주거 형태', question: '설치하실 곳은 어떤 형태인가요?', kind: 'select', required: true, options: [
    { value: 'apartment', label: '아파트' }, { value: 'villa', label: '빌라·다세대' }, { value: 'house', label: '단독·다가구' }, { value: 'officetel', label: '오피스텔' }, { value: 'other', label: '기타' }] },
  { key: 'subscriberType', label: '가입 명의', question: '가입 명의는 누구로 하실 예정인가요?', kind: 'select', required: true, options: [
    { value: 'self', label: '본인' }, { value: 'family', label: '가족' }, { value: 'business', label: '사업자' }] },
  { key: 'currentCarrier', label: '현재 이용 중인 인터넷', question: '지금 쓰고 계신 인터넷은 어느 통신사인가요?', kind: 'select', required: true, options: [
    { value: 'kt', label: 'KT' }, { value: 'skb', label: 'SK브로드밴드' }, { value: 'lgu', label: 'LG U+' }, { value: 'cable', label: '케이블 등 기타' }, { value: 'none', label: '이용 안 함' }] },
  { key: 'installPref', label: '희망 설치 시기', question: '설치는 언제쯤 원하세요?', kind: 'select', required: true, options: [
    { value: 'asap', label: '가능한 빨리' }, { value: 'within_week', label: '1주일 안' }, { value: 'within_month', label: '1개월 안' }, { value: 'undecided', label: '아직 미정' }] },
  { key: 'tvCount', label: 'TV 대수', question: '설치할 TV는 몇 대인가요? (선택)', kind: 'select', required: false, options: [
    { value: '1', label: '1대' }, { value: '2', label: '2대' }, { value: '3plus', label: '3대 이상' }] },
  { key: 'memo', label: '전달 메모', question: '총판에 전달할 말이 있으면 적어 주세요. (선택, 100자 이내)', kind: 'text', required: false, max: 100 },
]);

/** 상담 화면이 서버 설정으로 고정한 상품 선택(고객이 바꿀 수 없음). 코드 형식만 허용 */
export const CHOICE_KEYS = ['carrier', 'productId', 'regionCode'] as const;
const CHOICE_LABEL: Record<(typeof CHOICE_KEYS)[number], string> = { carrier: '통신사', productId: '상품', regionCode: '지역' };
const CODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type Application = { carrier?: string; productId?: string; regionCode?: string; installAddress?: string; housingType?: string; subscriberType?: string; currentCarrier?: string; installPref?: string; tvCount?: string; memo?: string };

/** AI 상담·신청서 어디서도 받지 않는 항목: 총판이 별도로 확인한다 */
export const DEALER_ONLY_ITEMS: readonly { readonly key: string; readonly label: string; readonly note: string }[] = Object.freeze([
  { key: 'rrn', label: '주민등록번호', note: '이 시스템·AI는 받지 않습니다. 총판이 별도 확인' },
  { key: 'autopay', label: '자동이체·결제수단', note: '이 시스템·AI는 받지 않습니다. 총판이 별도 확인' },
  { key: 'account', label: '계좌정보', note: '이 시스템·AI는 받지 않습니다. 총판이 별도 확인' },
  { key: 'identity', label: '가입자 본인 확인(명의·신분)', note: '총판이 별도 확인' },
  { key: 'price_confirm', label: '최종 요금·사은품·설치비 확정', note: '총판 확정값 우선(아래 승인 정책 안내는 참고)' },
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

/** 신청서 본문 검증: 알려진 키만, 문자열만, 선택값은 목록 안, 글은 길이·민감정보 검사. 일부 항목만 있어도 통과(누락은 별도 점검) */
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
      if (sensitiveReason(val)) return { ok: false, code: 'SENSITIVE_INPUT' };
    }
    (out as Record<string, string>)[k] = val;
  }
  return { ok: true, value: out };
}

/** 누락된 필수 항목 키(상품 선택 3개 + 고객 필수 항목). 신청서가 없으면 전부 누락 */
export function missingApplication(app: Application | null): string[] {
  const a = (app ?? {}) as Record<string, string | undefined>;
  return [...CHOICE_KEYS.filter((k) => !a[k]), ...APPLICATION_FIELDS.filter((f) => f.required && !a[f.key]).map((f) => f.key)];
}
export const labelOf = (key: string): string => CHOICE_LABEL[key as keyof typeof CHOICE_LABEL] ?? APPLICATION_FIELDS.find((f) => f.key === key)?.label ?? key;

/** 다음에 물을 항목(필수 먼저, 그 다음 선택). 모두 끝났으면 null */
export function nextQuestion(app: Application | null): FieldDef | null {
  const a = (app ?? {}) as Record<string, string | undefined>;
  return APPLICATION_FIELDS.find((f) => f.required && !a[f.key]) ?? APPLICATION_FIELDS.find((f) => !f.required && !a[f.key]) ?? null;
}

/** DB에 평문으로 두는 요약(개인정보 아님: 범주형 선택값·누락 목록만. 주소·메모는 암호화 본문에만) */
export function applicationSummary(app: Application): { answered: number; missing: string[]; carrier?: string; productId?: string; regionCode?: string; housingType?: string; currentCarrier?: string; installPref?: string } {
  const miss = missingApplication(app);
  const pick = (k: keyof Application) => (app[k] ? { [k]: app[k] } : {});
  return { answered: Object.values(app).filter(Boolean).length, missing: miss, ...pick('carrier'), ...pick('productId'), ...pick('regionCode'), ...pick('housingType'), ...pick('currentCarrier'), ...pick('installPref') };
}

export type PacketInput = {
  readonly lead: { readonly name: string; readonly phone: string; readonly interest: string; readonly contactTime: string | null; readonly createdAt: string };
  readonly app: Application | null;
  /** 서버가 승인 정책에서 만든 안내문(게시 OFF·정책 없음이면 '담당자 확인' 안내). 승인 정책 밖의 금액은 여기 들어오지 않는다 */
  readonly quote: { readonly kind: 'quote' | 'needs_review'; readonly text: string } | null;
  readonly generatedAt: string;
};
export type Packet = {
  readonly status: 'complete' | 'incomplete';
  readonly missing: readonly string[];
  readonly missingLabels: readonly string[];
  readonly dealerOnly: readonly { key: string; label: string; note: string }[];
  readonly sections: readonly { readonly title: string; readonly rows: readonly (readonly [string, string])[] }[];
  readonly text: string;
};

const OPT = (key: string, v: string | undefined) => (v ? APPLICATION_FIELDS.find((f) => f.key === key)?.options?.find((o) => o.value === v)?.label ?? v : '');
const NONE = '(미입력)';

/** 총판 전달용 자료: 고객 확인 정보 + 상담 선택 + 승인 정책 안내 + 총판 별도 확인 항목. 문자열만 만든다(저장·전송 없음) */
export function buildDealerPacket(i: PacketInput): Packet {
  const a = i.app ?? {};
  const missing = missingApplication(i.app);
  const sections: { title: string; rows: (readonly [string, string])[] }[] = [
    { title: '고객 정보', rows: [['이름', i.lead.name], ['연락처', i.lead.phone], ['연락 가능 시간', i.lead.contactTime ?? NONE], ['접수 시각', i.lead.createdAt]] },
    { title: '신청 상품', rows: [['관심 상품', i.lead.interest], ['통신사', a.carrier ?? NONE], ['상품 코드', a.productId ?? NONE], ['지역 코드', a.regionCode ?? NONE]] },
    { title: '설치 정보', rows: [['설치 주소', a.installAddress ?? NONE], ['주거 형태', OPT('housingType', a.housingType) || NONE], ['희망 설치 시기', OPT('installPref', a.installPref) || NONE], ['TV 대수', OPT('tvCount', a.tvCount) || '(선택 안 함)']] },
    { title: '가입 정보', rows: [['가입 명의(고객 응답)', OPT('subscriberType', a.subscriberType) || NONE], ['현재 이용 인터넷', OPT('currentCarrier', a.currentCarrier) || NONE], ['전달 메모', a.memo ?? '(없음)']] },
    { title: '안내된 요금·사은품(승인 정책 기준)', rows: [[i.quote?.kind === 'quote' ? '승인 정책 안내' : '정책 상태', i.quote?.text ?? '승인 정책 안내 없음 — 총판 확인']] },
  ];
  const dealerOnly = DEALER_ONLY_ITEMS.map((d) => ({ ...d }));
  const lines = [`[총판 전달용 신청서] 생성 ${i.generatedAt}`, ''];
  for (const s of sections) { lines.push(`■ ${s.title}`); for (const [k, v] of s.rows) lines.push(`- ${k}: ${v}`); lines.push(''); }
  lines.push('■ 총판 별도 확인 항목(이 시스템·AI에서 수집하지 않음)');
  for (const d of dealerOnly) lines.push(`- ${d.label}: ${d.note}`);
  if (missing.length > 0) { lines.push('', `※ 누락 항목: ${missing.map(labelOf).join(', ')}`); }
  return { status: missing.length === 0 ? 'complete' : 'incomplete', missing, missingLabels: missing.map(labelOf), dealerOnly, sections, text: lines.join('\n') };
}
