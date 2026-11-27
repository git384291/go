import 'server-only';
import { createHash } from 'node:crypto';
import type { CrmAdminDeps } from './crmAdmin';
import { gate } from './crmAdmin';
import { createPiiCrypto, maskName, normalizeMobile, piiKeysFromEnv, type PiiCrypto } from '../security/piiCrypto';

export const NAVER_FORM_DOC_VERSION = 'naver-form-2026-11-28';
const MAX_ROWS = 100;
const MAX_COLUMNS = 100;
const MAX_FIELD = 500;
const H = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } as const;
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: H });

export type NaverImportDeps = CrmAdminDeps & { crypto: () => PiiCrypto };
export type ParsedNaverRow = { row: number; kind: string; name: string; phone: string; consent: string; area: string };

function parseDelimited(text: string, delimiter: ',' | '\t'): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field.length === 0) quoted = true;
    else if (c === delimiter) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
    if (field.length > MAX_FIELD) throw new Error('FIELD_TOO_LARGE');
  }
  if (quoted) throw new Error('INVALID_CSV');
  if (field.length || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  if (rows.some((r) => r.length > MAX_COLUMNS)) throw new Error('TOO_MANY_COLUMNS');
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

const cleanHeader = (s: string) => s.replace(/^\uFEFF/, '').replace(/^\s*\d+\.\s*/, '').trim();
const headerIndex = (headers: string[], expected: string) => headers.findIndex((h) => cleanHeader(h) === expected);

/** 네이버 결과 CSV/TSV를 읽는다. 개인정보 값은 반환만 하며 기록·로그하지 않는다. */
export function parseNaverFormExport(text: string): ParsedNaverRow[] {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const rows = parseDelimited(text.replace(/^\uFEFF/, ''), (first.match(/\t/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? '\t' : ',');
  if (rows.length < 2) throw new Error('NO_ANSWERS');
  if (rows.length - 1 > MAX_ROWS) throw new Error('TOO_MANY_ROWS');
  const h = rows[0]!.map(cleanHeader);
  const idx = {
    kind: headerIndex(h, '원하시는 가입 유형'), name: headerIndex(h, '성함'), phone: headerIndex(h, '연락처'),
    consent: headerIndex(h, '개인정보 수집 및 이용 동의'), area: headerIndex(h, '설치 희망 지역(시·군·구)'),
  };
  if (Object.values(idx).some((n) => n < 0)) throw new Error('HEADERS_MISMATCH');
  return rows.slice(1).map((r, i) => ({
    row: i + 2, kind: (r[idx.kind] ?? '').trim(), name: (r[idx.name] ?? '').trim(), phone: (r[idx.phone] ?? '').trim(),
    consent: (r[idx.consent] ?? '').trim(), area: (r[idx.area] ?? '').trim(),
  }));
}

function prepare(row: ParsedNaverRow, crypto: PiiCrypto) {
  if (row.kind !== '인터넷+TV') throw new Error(row.kind === '인터넷만' ? 'PRODUCT_NOT_ACTIVE' : 'INVALID_PRODUCT');
  if (row.consent.replace(/[.\s]/g, '') !== '동의합니다') throw new Error('CONSENT_REQUIRED');
  if (!/^[가-힣a-zA-Z\s]{1,20}$/u.test(row.name)) throw new Error('INVALID_NAME');
  if (!row.area || row.area.length > 100 || /[\u0000-\u001f\u007f]/.test(row.area)) throw new Error('INVALID_AREA');
  const phone = normalizeMobile(row.phone);
  const digest = createHash('sha256').update([row.kind, row.name, phone, row.consent, row.area].join('\u001f'), 'utf8').digest('hex');
  return {
    nameEnc: crypto.encrypt(row.name), nameMasked: maskName(row.name), phoneEnc: crypto.encrypt(phone),
    phoneHmac: crypto.phoneHmac(phone), phoneLast4: phone.slice(-4), areaEnc: crypto.encrypt(row.area),
    idempotencyKey: `naver-${digest.slice(0, 58)}`,
  };
}

const DB_MESSAGES = new Set(['CONSENT_REQUIRED', 'CONSENT_VERSION_MISMATCH', 'INVALID_INPUT']);

export async function importNaverForm(deps: NaverImportDeps, raw: string): Promise<Response> {
  const who = await gate(deps);
  if (who instanceof Response) return who;
  let rows: ParsedNaverRow[];
  let crypto: PiiCrypto;
  try { rows = parseNaverFormExport(raw); crypto = deps.crypto(); }
  catch (e) { return json({ ok: false, code: e instanceof Error ? e.message : 'INVALID_CSV' }, 400); }

  const valid: Array<{ row: number; data: ReturnType<typeof prepare> }> = [];
  const rejected: Array<{ row: number; code: string }> = [];
  for (const row of rows) {
    try { valid.push({ row: row.row, data: prepare(row, crypto) }); }
    catch (e) { rejected.push({ row: row.row, code: e instanceof Error ? e.message : 'INVALID_ROW' }); }
  }
  if (valid.length === 0) return json({ ok: false, code: 'NO_VALID_ROWS', rejected }, 422);

  try {
    const results = await deps.runInTransaction(async (tx) => {
      const out: Array<{ row: number; result: string }> = [];
      for (const item of valid) {
        const a = item.data;
        const dbRows = await tx`select api.naver_form_import(${who.actor}::uuid, ${who.session}::uuid, ${who.token},
          ${a.nameEnc}, ${a.nameMasked}, ${a.phoneEnc}, ${a.phoneHmac}, ${a.phoneLast4}, ${a.areaEnc}, ${a.idempotencyKey},
          ${true}, ${NAVER_FORM_DOC_VERSION}) as result`;
        const result = (dbRows[0] as { result?: unknown } | undefined)?.result;
        if (result !== 'imported' && result !== 'duplicate' && result !== 'already') throw new Error('DB_UNAVAILABLE');
        out.push({ row: item.row, result });
      }
      return out;
    });
    return json({ ok: true, imported: results.filter((r) => r.result === 'imported').length, duplicates: results.filter((r) => r.result !== 'imported').length, rejected }, 200);
  } catch (e) {
    const err = (e ?? {}) as { code?: unknown; message?: unknown };
    if (err.code === '42501') return json({ ok: false, code: 'FORBIDDEN' }, 403);
    if (err.code === '22023' && typeof err.message === 'string') return json({ ok: false, code: DB_MESSAGES.has(err.message) ? err.message : 'INVALID_INPUT' }, 422);
    if (err.code === '55000') return json({ ok: false, code: 'SERVICE_NOT_READY' }, 503);
    return json({ ok: false, code: 'DB_UNAVAILABLE' }, 503);
  }
}

export const defaultNaverCrypto = () => createPiiCrypto(piiKeysFromEnv());
