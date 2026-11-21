// PM 11/21: 관리자 정책 화면(PolicyAdminView + 조작 컴포넌트)을 실제 브라우저에서 조작해 검수한다.
// - Next.js 없이 esbuild로 묶어 가상 주소(http://policy.test)에 띄운다. /api/admin/policies* 는 Playwright 가로채기로 가짜 응답만 준다.
// - 확인할 것: 승인은 5개 확인 + 사유 전에는 못 보냄, 역할별 버튼 노출, 서버가 거절하면 그대로 거절 표시(화면이 권한을 정하지 않음),
//   업로드 '검증만'은 dryRun 요청, 잘못된 JSON은 요청 0회, 외부 요청 0, 모바일 가로 넘침 없음.
// 실행: node scripts/preview/policy-interaction.mjs   (npm run test:preview 단계)
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ORIGIN = 'http://policy.test';
const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${detail ? ` | ${detail}` : ''}`);
}

const ID1 = '10000000-0000-4000-8000-000000000001'; // 검수 대기
const ID3 = '10000000-0000-4000-8000-000000000003'; // 초안
const ROWS = [
  { id: ID1, supplier_id: 'sample-supplier', segment: 'household', carrier: 'sample-carrier', product_id: 'sample-1', category: 'internet_tv', revision: 1, state: 'submitted', source_kind: 'official_policy_sheet', product_label: '인터넷+TV 샘플', confirmed_at: '2026-11-21T09:00:00+09:00', valid_from: '2026-11-21T00:00:00+09:00', valid_until: '2026-11-30T00:00:00+09:00', content_hash: 'ab12cd34ef56', self_approval: false, decided_at: null, decision_reason: null },
  { id: ID3, supplier_id: 'sample-supplier', segment: 'household', carrier: 'sample-carrier', product_id: 'sample-3', category: 'internet_tv', revision: 1, state: 'draft', source_kind: 'training_material', product_label: '인터넷+TV 샘플 C', confirmed_at: '2026-11-19T09:00:00+09:00', valid_from: '2026-11-19T00:00:00+09:00', valid_until: '2026-11-30T00:00:00+09:00', content_hash: '1122334455aa', self_approval: false, decided_at: null, decision_reason: null },
];

async function bundle(role) {
  const entry = `
    import { createRoot } from 'react-dom/client';
    import { PolicyAdminView } from './src/app/admin/policies/PolicyAdminView';
    createRoot(document.getElementById('root')).render(<PolicyAdminView items={${JSON.stringify(ROWS)}} role=${JSON.stringify(role)} publishOn={false} />);`;
  const out = await build({
    stdin: { contents: entry, loader: 'tsx', resolveDir: ROOT, sourcefile: 'policy-entry.tsx' },
    bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  return out.outputFiles[0].text;
}

async function open(browser, role, api) {
  const js = await bundle(role);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await ctx.newPage();
  const seen = { external: [], api: [], pageErrors: [] };
  page.on('pageerror', (e) => seen.pageErrors.push(e.message.split('\n')[0]));
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.origin !== ORIGIN) { seen.external.push(u.host); return route.abort('blockedbyclient'); }
    if (u.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/p.js"></script>' });
    if (u.pathname === '/p.js') return route.fulfill({ contentType: 'text/javascript', body: js });
    if (u.pathname.startsWith('/api/admin/policies')) {
      const body = JSON.parse(req.postData() ?? '{}');
      seen.api.push({ path: u.pathname, body });
      return api(route, body);
    }
    return route.abort('blockedbyclient');
  });
  await page.goto(`${ORIGIN}/`);
  await page.waitForSelector('table');
  return { page, ctx, seen };
}
const reply = (status, body) => (route) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const ALL = { source_matched: true, validity: true, vat: true, benefit_terms: true, region_bundle: true };

async function scenarioOwner(browser) {
  const { page, ctx, seen } = await open(browser, 'owner', (route) => reply(403, { ok: false, code: 'FORBIDDEN' })(route));
  const approve = page.getByRole('button', { name: '승인', exact: true });
  const reject = page.getByRole('button', { name: '반려', exact: true });
  check('P1 대표 화면: 승인·반려는 처음에 잠김, 초안 행은 검수 요청만', (await approve.isDisabled()) && (await reject.isDisabled()) && (await page.getByRole('button', { name: '검수 요청' }).count()) === 1);
  const boxes = page.locator('td input[type=checkbox]');
  for (let i = 0; i < 4; i++) await boxes.nth(i).check();
  await page.fill('input[aria-label=사유]', '정책표와 대조 완료');
  check('P2 확인 항목 4개 + 사유만으로는 승인 잠김', await approve.isDisabled());
  await boxes.nth(4).check();
  check('P3 5개 확인 + 사유가 모두 있어야 승인 열림', !(await approve.isDisabled()) && seen.api.length === 0);
  await approve.click();
  await page.waitForFunction(() => document.querySelector('td [role=status]')?.textContent?.includes('거부됨'));
  const sent = seen.api[0];
  check('P4 승인 요청 본문: action·사유·확인 5개 전부 true', seen.api.length === 1 && sent.path === `/api/admin/policies/${ID1}` && sent.body.action === 'approve' && sent.body.reason === '정책표와 대조 완료' && JSON.stringify(sent.body.checks) === JSON.stringify(ALL), JSON.stringify(sent.body));
  check('P5 서버가 거절(403)하면 화면도 거절만 표시(승인된 것처럼 바뀌지 않음)', (await page.textContent('td [role=status]')).includes('FORBIDDEN') && (await page.getByText('승인·견적 사용').count()) === 0);
  await boxes.nth(0).uncheck();
  check('P6 확인 하나를 풀면 다시 잠김', await approve.isDisabled());
  await page.fill('input[aria-label=사유]', '');
  await boxes.nth(0).check();
  check('P7 사유가 비면 반려도 잠김', await reject.isDisabled());
  await page.fill('input[aria-label=사유]', '조건 불일치');
  await reject.click();
  await page.waitForFunction(() => document.querySelectorAll('td [role=status]')[0]?.textContent?.includes('FORBIDDEN'));
  const rej = seen.api[1];
  check('P8 반려 요청 본문: action·사유만(확인 항목 없음)', rej.body.action === 'reject' && rej.body.reason === '조건 불일치' && !('checks' in rej.body), JSON.stringify(rej.body));
  await page.getByRole('button', { name: '검수 요청' }).click();
  await page.waitForTimeout(150);
  check('P9 검수 요청 본문: action=submit 하나', seen.api[2].path === `/api/admin/policies/${ID3}` && JSON.stringify(seen.api[2].body) === '{"action":"submit"}');
  check('P10 외부 요청 0·페이지 예외 0·가로 넘침 없음', seen.external.length === 0 && seen.pageErrors.length === 0 && (await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)), `ext=${seen.external.length} err=${seen.pageErrors.length}`);
  await ctx.close();
}

async function scenarioUpload(browser) {
  const { page, ctx, seen } = await open(browser, 'policy_editor', (route, body) => reply(200, { ok: true, dryRun: body.dryRun === true, quotable: false, reasons: ['MONTHLY_FEE_UNKNOWN'] })(route));
  check('P11 정책 담당 화면: 승인·반려 버튼 없음, 제출·대표 대기 표시', (await page.getByRole('button', { name: '승인', exact: true }).count()) === 0 && (await page.getByRole('button', { name: '반려', exact: true }).count()) === 0 && (await page.getByText('대표 승인 대기').count()) === 1);
  await page.fill('textarea[aria-label="정책 JSON"]', '{ 깨진 json');
  await page.getByRole('button', { name: '검증만' }).click();
  check('P12 잘못된 JSON: 요청 0회·안내 문구', seen.api.length === 0 && (await page.textContent('section[aria-label="정책 업로드"] [role=status]')).includes('JSON'));
  await page.fill('textarea[aria-label="정책 JSON"]', JSON.stringify({ supplierId: 'a', terms: {} }));
  await page.getByRole('button', { name: '검증만' }).click();
  await page.waitForFunction(() => document.querySelector('section[aria-label="정책 업로드"] [role=status]')?.textContent?.includes('검증 완료'));
  check('P13 검증만: dryRun=true 요청, 견적 불가 사유 표시', seen.api.length === 1 && seen.api[0].path === '/api/admin/policies' && seen.api[0].body.dryRun === true && (await page.textContent('section[aria-label="정책 업로드"] [role=status]')).includes('MONTHLY_FEE_UNKNOWN'));
  check('P14 외부 요청 0·페이지 예외 0', seen.external.length === 0 && seen.pageErrors.length === 0);
  await ctx.close();
}

async function scenarioReviewer(browser) {
  const { page, ctx, seen } = await open(browser, 'reviewer', reply(403, { ok: false }));
  check('P15 검토자 화면: 업로드 칸·모든 조작 버튼 없음(조회만)', (await page.locator('textarea').count()) === 0 && (await page.locator('td button').count()) === 0 && (await page.getByText('조회만 가능').count()) === 1);
  check('P16 검토자 화면: 요청 0회', seen.api.length === 0);
  await ctx.close();
}

const browser = await chromium.launch();
try {
  for (const s of [scenarioOwner, scenarioUpload, scenarioReviewer]) {
    try { await s(browser); } catch (e) { check(`${s.name} 실행 중 예외 없음`, false, String(e.message).split('\n')[0]); }
  }
} finally {
  await browser.close();
}
const fail = results.filter((r) => !r.pass).length;
console.log(`== 관리자 정책 화면 상호작용 검수: pass=${results.length - fail} fail=${fail}`);
process.exit(fail === 0 && results.length > 0 ? 0 : 1);
