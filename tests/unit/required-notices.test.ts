// PM 11/21: 필수 고지 설정 시험. 실제 문구는 확정 전이므로 기본 설정은 접수 불가여야 한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noticeReadiness, REQUIRED_NOTICES, sameNoticeKeys, type NoticeConfig } from '../../src/content/requiredNotices';

const ok: NoticeConfig = { version: 'v1', confirmed: true, items: [{ key: 'a', title: 't', body: 'b' }, { key: 'b', title: 't', body: 'b' }] };

test('RN1 실제 설정은 미확정(접수 불가)이며 동결되어 있다', () => {
  assert.equal(REQUIRED_NOTICES.confirmed, false);
  assert.deepEqual(noticeReadiness(REQUIRED_NOTICES, ''), { ready: false, reason: 'NOTICE_NOT_CONFIRMED' });
  assert.ok(Object.isFrozen(REQUIRED_NOTICES));
});

test('RN2 확정·버전 일치·항목 유효할 때만 준비됨', () => {
  assert.deepEqual(noticeReadiness(ok, 'v1'), { ready: true });
  assert.equal(noticeReadiness(ok, 'v2').ready, false);
  assert.equal(noticeReadiness(ok, '').ready, false);
  assert.equal(noticeReadiness({ ...ok, items: [] }, 'v1').ready, false);
  assert.equal(noticeReadiness({ ...ok, items: [{ key: 'A', title: 't', body: 'b' }] }, 'v1').ready, false);
  assert.equal(noticeReadiness({ ...ok, items: [{ key: 'a', title: 't', body: ' ' }] }, 'v1').ready, false);
  assert.equal(noticeReadiness({ ...ok, items: [ok.items[0], ok.items[0]] }, 'v1').ready, false);
});

test('RN3 확인 키는 필수 항목과 정확히 같아야 함', () => {
  assert.equal(sameNoticeKeys(ok, ['b', 'a']), true);
  assert.equal(sameNoticeKeys(ok, ['a']), false);
  assert.equal(sameNoticeKeys(ok, ['a', 'a']), false);
  assert.equal(sameNoticeKeys(ok, ['a', 'b', 'c']), false);
});

import { compareNoticeTexts } from '../../src/content/requiredNotices';
test('RN-C 화면 고지와 DB 문구 대조: 같으면 빈 배열, 누락·초과·문구 불일치·버전 없음은 사유 코드(문구 비노출)', () => {
  const cfg = { version: 'v1', confirmed: true, items: [{ key: 'a', title: 't', body: '문구 A' }, { key: 'b', title: 't', body: '문구 B' }] };
  const rows = [{ version: 'v1', notice_key: 'a', body: '문구 A' }, { version: 'v1', notice_key: 'b', body: ' 문구 B ' }, { version: 'v0', notice_key: 'z', body: 'x' }];
  assert.deepEqual(compareNoticeTexts(cfg, rows), []);
  assert.deepEqual(compareNoticeTexts(cfg, [rows[0]]), ['KEY_MISSING_IN_DB:b']);
  assert.deepEqual(compareNoticeTexts(cfg, [...rows, { version: 'v1', notice_key: 'c', body: 'c' }]), ['KEY_EXTRA_IN_DB:c']);
  assert.deepEqual(compareNoticeTexts(cfg, [rows[0], { ...rows[1], body: '다른 문구' }]), ['BODY_MISMATCH:b']);
  assert.deepEqual(compareNoticeTexts(cfg, [{ version: 'v0', notice_key: 'a', body: '문구 A' }]), ['NO_DB_TEXTS']);
  assert.deepEqual(compareNoticeTexts({ ...cfg, version: '' }, rows), ['NO_DB_TEXTS']);
  assert.ok(!JSON.stringify(compareNoticeTexts(cfg, [rows[0], { ...rows[1], body: '비밀 문구' }])).includes('비밀'));
});
