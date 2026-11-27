// PM 7016940331: H11 not-found 판정(scripts/server-smoke/notFound.mjs)의 양성·음성 시험.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isHtmlNotFound, isRscNotFound, rscNotFoundDigest } from '../../scripts/server-smoke/notFound.mjs';

const RSC = 'text/x-component';
const D = 'NEXT_HTTP_ERROR_FALLBACK;404';
const errRow = (digest: string) => `0:{"b":"x"}\n1:E{"digest":"${digest}"}\n`;

test('NF1 양성: HTML 404 / RSC 404 / RSC 200+x-component+오류 행 digest', () => {
  assert.equal(isHtmlNotFound({ status: 404 }), true);
  assert.equal(isRscNotFound({ status: 404, contentType: 'text/html', body: '' }).ok, true);
  assert.deepEqual(isRscNotFound({ status: 200, contentType: `${RSC}; charset=utf-8`, body: errRow(D) }), { ok: true, via: D });
  assert.equal(isRscNotFound({ status: 200, contentType: RSC, body: errRow('NEXT_NOT_FOUND') }).ok, true);
});

test('NF2 음성: 500에 같은 문자열이 있어도 실패', () => {
  assert.equal(isRscNotFound({ status: 500, contentType: RSC, body: errRow(D) }).ok, false);
  assert.equal(isRscNotFound({ status: 500, contentType: 'text/html', body: `<p>${D}</p>` }).ok, false);
});

test('NF3 음성: 200 HTML(예시 문구에 같은 문자열)은 RSC로 통과하지 않음', () => {
  assert.equal(isRscNotFound({ status: 200, contentType: 'text/html; charset=utf-8', body: `<pre>${D} NEXT_NOT_FOUND</pre>` }).ok, false);
  assert.equal(isRscNotFound({ status: 200, contentType: 'text/html', body: errRow(D) }).ok, false);
});

test('NF4 음성: 200 RSC 일반 콘텐츠가 문자열을 언급해도 실패(오류 행 아님·digest 불일치·단순 404 숫자)', () => {
  assert.equal(isRscNotFound({ status: 200, contentType: RSC, body: `0:["$","p",null,{"children":"${D}"}]\n` }).ok, false);
  assert.equal(isRscNotFound({ status: 200, contentType: RSC, body: `1:"NEXT_NOT_FOUND"\n` }).ok, false);
  assert.equal(isRscNotFound({ status: 200, contentType: RSC, body: `1:E{"message":"see ${D}"}\n` }).ok, false);
  assert.equal(isRscNotFound({ status: 200, contentType: RSC, body: errRow('NEXT_REDIRECT;replace;/x;307;') }).ok, false);
  assert.equal(isRscNotFound({ status: 200, contentType: RSC, body: '0:["$","p",null,{"children":"404"}]\n' }).ok, false);
  assert.equal(isRscNotFound({ status: 200, contentType: RSC, body: '1:E{깨진 json\n' }).ok, false);
  assert.equal(isRscNotFound({ status: 200, contentType: null, body: errRow(D) }).ok, false);
  // PM 7018202454: 매개변수 안에 x-component가 들어간 text/html, 16진수가 아닌 행 ID
  assert.equal(isRscNotFound({ status: 200, contentType: 'text/html; note="text/x-component"', body: errRow(D) }).ok, false);
  assert.equal(isRscNotFound({ status: 200, contentType: RSC, body: `z1:E{"digest":"${D}"}\n` }).ok, false);
  assert.equal(isRscNotFound({ status: 200, contentType: 'TEXT/X-COMPONENT ; charset=utf-8', body: `a1f:E{"digest":"${D}"}\n` }).ok, true);
});

test('NF5 digest 추출은 오류 행의 정확한 일치만', () => {
  assert.equal(rscNotFoundDigest(errRow(D)), D);
  assert.equal(rscNotFoundDigest(`1:E{"digest":"${D}x"}`), null);
  assert.equal(rscNotFoundDigest('1:I{"digest":"NEXT_NOT_FOUND"}'), null);
  assert.equal(isHtmlNotFound({ status: 200 }), false);
});
