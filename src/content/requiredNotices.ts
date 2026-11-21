/**
 * 인터넷+TV 접수 필수 고지·동의 항목 (PM 11/21). 브라우저·서버 공용 상수(순수 데이터, 비밀 없음).
 * - 문구는 버전으로 고정한다. 문구를 바꾸면 version을 올리고, DB core.notice_texts에도 같은 버전·같은 문구를 넣어야 한다
 *   (DB가 고객별 노출 기록에 문구 해시를 남기므로, 화면 문구와 DB 문구가 다르면 감사에서 드러난다).
 * - confirmed=false(현재)이면 실제 접수를 받지 않는다: 화면은 제출을 막고, 서버(buildCreateLeadArgs)도 거부한다.
 * - 실제 문구·버전은 PM·대표가 확정해 주기 전까지 비어 있다. 임의 문구를 넣지 않는다.
 */
export type RequiredNotice = {
  readonly key: string;   // DB notice_key와 같은 값(^[a-z][a-z0-9_]{0,39}$)
  readonly title: string;
  readonly body: string;
};
export type NoticeConfig = {
  readonly version: string;     // 처리방침 버전(PRIVACY_POLICY_VERSION)과 같아야 한다
  readonly confirmed: boolean;  // 대표·PM이 문구를 확정했을 때만 true
  readonly items: readonly RequiredNotice[];
};

export const REQUIRED_NOTICES: NoticeConfig = Object.freeze({
  version: '',
  confirmed: false,
  items: Object.freeze([]) as readonly RequiredNotice[],
});

const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** 접수 가능 여부. 사유 코드만 돌려준다(문구 비노출) */
export function noticeReadiness(cfg: NoticeConfig, privacyVersion: string): { ready: true } | { ready: false; reason: string } {
  if (!cfg.confirmed) return { ready: false, reason: 'NOTICE_NOT_CONFIRMED' };
  if (cfg.version === '' || cfg.version !== privacyVersion) return { ready: false, reason: 'NOTICE_VERSION_MISMATCH' };
  if (cfg.items.length === 0) return { ready: false, reason: 'NOTICE_EMPTY' };
  const keys = new Set<string>();
  for (const n of cfg.items) {
    if (!KEY_RE.test(n.key) || keys.has(n.key) || n.title.trim() === '' || n.body.trim() === '') return { ready: false, reason: 'NOTICE_INVALID' };
    keys.add(n.key);
  }
  return { ready: true };
}

/** 고객이 확인했다고 보낸 키가 필수 항목과 정확히 같은지(순서 무관·중복 불가) */
export function sameNoticeKeys(cfg: NoticeConfig, sent: readonly string[]): boolean {
  if (sent.length !== cfg.items.length || new Set(sent).size !== sent.length) return false;
  return cfg.items.every((n) => sent.includes(n.key));
}

export type NoticeTextRow = { readonly version: string; readonly notice_key: string; readonly body: string };

/**
 * 화면 상수(NoticeConfig)와 DB 문구(core.notice_texts)의 일치 점검. 사유 코드만 돌려준다(문구 비노출).
 * 빈 배열이면 같은 버전·같은 키 집합·같은 문구다. 접수 개방 전 점검 전용(읽기만, 접수 가능 여부를 바꾸지 않는다).
 */
export function compareNoticeTexts(cfg: NoticeConfig, rows: readonly NoticeTextRow[]): readonly string[] {
  const mine = rows.filter((r) => r.version === cfg.version);
  if (cfg.version === '' || mine.length === 0) return ['NO_DB_TEXTS'];
  const out: string[] = [];
  const dbKeys = new Map(mine.map((r) => [r.notice_key, r.body]));
  for (const n of cfg.items) {
    if (!dbKeys.has(n.key)) out.push(`KEY_MISSING_IN_DB:${n.key}`);
    else if (dbKeys.get(n.key)!.trim() !== n.body.trim()) out.push(`BODY_MISMATCH:${n.key}`);
  }
  for (const k of dbKeys.keys()) if (!cfg.items.some((n) => n.key === k)) out.push(`KEY_EXTRA_IN_DB:${k}`);
  return out;
}
