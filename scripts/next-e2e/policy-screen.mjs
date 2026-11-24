// PM 11/24 ⑤ 정책 승인·게시 E2E — 실제 관리자 화면(브라우저)으로 업로드 → 검증 → 초안 → 검수 요청 → 대표 승인 → 게시, 고객 상담 반영.
// 기존 Q1~Q16·PB1~PB6(API)·BF(접수 흐름)는 다시 하지 않는다. 여기서는 그동안 없던 것만: 화면 조작, 원본 ↔ DB 값 일치,
// 새 버전 교체 시 이전 버전·감사 보존, 만료, 동시 승인, 화면 입력 오류, 다른 데이터 불변.
// 가짜 정책만(supplier-a·carrier-x·next-e2e-ui*), 폐기 DB(run.sh)에서만. 게시 스위치는 끝나면 원래 값으로 되돌린다.
const NUM = /\d{1,3}(,\d{3})+원/;
// jsonb는 키 순서를 바꿔 저장한다 → 키를 정렬해 값만 비교
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v));

export async function runPolicyScreen({ sql, n, check, adm, pj, chat, BASE, owner, editor, reviewer }) {
  const { chromium } = await import('playwright');
  const flag = async () => (await sql.unsafe(`select enabled from core.feature_flags where key = 'policy_publish'`))[0]?.enabled;
  const flag0 = await flag();
  const OTHERS = `product_id not like 'next-e2e-ui%'`;
  const snapOthers = async () => (await sql.unsafe(`select count(*)::int as c, coalesce(md5(string_agg(id::text || state || content_hash || coalesce(decided_by::text, ''), ',' order by id)), '-') as h from core.policy_versions where ${OTHERS}`))[0];
  const audit0 = await n(`select coalesce(max(id), 0)::int as n from core.audit_logs`);
  const auditOld = async () => (await sql.unsafe(`select coalesce(md5(string_agg(id::text || action || coalesce(detail::text, ''), ',' order by id)), '-') as h from core.audit_logs where id <= ${audit0}`))[0]?.h;
  const others0 = await snapOthers(); const auditH0 = await auditOld();
  await sql.unsafe(`delete from core.consult_rate`); // 폐기 DB: 앞 시험이 쓴 전체 새 세션 한도(1시간 60개)를 이 흐름이 물려받지 않게
  let ip = 150; const ask = async (productId) => { const r = await chat({ productId }, `198.51.100.${ip++}`); return { status: r.status, text: String(r.j?.text ?? '') }; };
  const rowsOf = (pid) => sql.unsafe(`select id, revision, state, terms, product_label, valid_from, valid_until, created_by, decided_by, self_approval, checks, superseded_at from core.policy_versions where product_id = '${pid}' order by revision`);
  const kn = (value) => ({ known: true, value }); const krw = (v) => kn({ amountKrw: v, vat: 'included' });
  const t = Date.now();
  const src = (pid, fee, gift, untilMs = 86_400_000) => ({ supplierId: 'supplier-a', segment: 'household', carrier: 'carrier-x', productId: pid, category: 'internet_tv', sourceKind: 'official_policy_sheet',
    confirmedAt: new Date(t - 3600_000).toISOString(), validFrom: new Date(t - 3600_000).toISOString(), validUntil: new Date(Date.now() + untilMs).toISOString(), productLabel: `가상 화면 E2E ${pid}`,
    terms: { monthlyFee: krw(fee), contractMonths: kn(24), equipmentMonthlyFee: krw(1100), installFee: krw(4400), bundlePrerequisites: kn([]), regionScope: kn('nationwide'),
      customerBenefit: kn({ amountKrw: gift, form: 'gift_card', payoutCondition: kn('개통 후 지급(가상)'), cancellationCondition: kn('약정 내 해지 시 환수(가상)') }) } });
  const CHK = { source_matched: true, validity: true, vat: true, benefit_terms: true, region_bundle: true };
  const UI = 'next-e2e-ui1';
  const v1 = src(UI, 27_700, 5_500);

  const br = await chromium.launch();
  const pageAs = async (cookie) => {
    const ctx = await br.newContext({ viewport: { width: 1100, height: 1800 }, bypassCSP: true });
    const [cn, ...cv] = cookie.split('='); await ctx.addCookies([{ name: cn, value: cv.join('='), url: BASE }]);
    const p = await ctx.newPage(); await p.goto(`${BASE}/admin/policies`, { waitUntil: 'networkidle' }); return p;
  };
  const row = (p, pid) => p.locator('tr', { has: p.locator('small', { hasText: pid }) });
  try {
    // ── 1. 편집자 화면: 업로드(JSON) → 검증 → 초안 저장 ──
    const ed = await pageAs(editor);
    await ed.fill('textarea[aria-label="정책 JSON"]', '{ 깨진 JSON');
    await ed.click('button:has-text("검증만")');
    await ed.waitForTimeout(300);
    const badMsg = await ed.locator('section[aria-label="정책 업로드"]').innerText();
    check('PS1 화면 입력 오류: 깨진 JSON은 "JSON 형식이 올바르지 않습니다", 서버 요청·DB 저장 없음', badMsg.includes('JSON 형식이 올바르지 않습니다') && (await rowsOf(UI)).length === 0);
    // 설계(기존): 형식(키·known)만 맞으면 견적 불가 초안도 저장되고 사유를 보여 준다. 다른 상품 ID로 분리(본 흐름 개정 번호에 섞이지 않게)
    const BAD = 'next-e2e-ui0';
    const vb = src(BAD, 1, 1); vb.terms.monthlyFee = { known: true, value: { amountKrw: '27,700', vat: 'included' } };
    await ed.fill('textarea[aria-label="정책 JSON"]', JSON.stringify(vb, null, 2));
    await Promise.all([ed.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => null), ed.click('button:has-text("초안 저장")')]);
    const rb = await rowsOf(BAD);
    const dryBad = await pj(await adm('/api/admin/policies', editor, { method: 'POST', body: JSON.stringify({ ...vb, dryRun: true }) }));
    check('PS2 화면 데이터 검증: 금액이 숫자가 아니면 "견적 불가"로 판정(사유 표시), 초안은 저장되나 견적 가능 아님', rb.length === 1 && rb[0].state === 'draft' && dryBad.quotable === false && Array.isArray(dryBad.reasons) && dryBad.reasons.length > 0,
      `rows=${rb.length} quotable=${dryBad.quotable} reasons=${(dryBad.reasons ?? []).join('|')}`);
    // 진단(판정 없음): 견적 불가 초안을 대표가 승인할 수 있는지, 승인되면 고객 상담이 어떻게 되는지 기록만 한다(결과는 보고서에)
    {
      const polD = (c, body, p) => adm(p, c, { method: 'POST', body: JSON.stringify(body) });
      const sub = await polD(editor, { action: 'submit' }, `/api/admin/policies/${rb[0]?.id}`);
      const apr = await polD(owner, { action: 'approve', reason: '견적 불가 초안 승인 시도(진단)', checks: { source_matched: true, validity: true, vat: true, benefit_terms: true, region_bundle: true } }, `/api/admin/policies/${rb[0]?.id}`);
      const st = (await rowsOf(BAD))[0]?.state;
      await sql.unsafe(`update core.feature_flags set enabled = true where key = 'policy_publish'`);
      const rq = await chat({ productId: BAD }, '198.51.100.149');
      await sql.unsafe(`update core.feature_flags set enabled = ${flag0 === true} where key = 'policy_publish'`);
      console.log(`INFO | PS2d 견적 불가 초안: submit=${sub.status} approve=${apr.status} state=${st} chat=${rq.status} next=${rq.j?.next ?? '-'} amount=${NUM.test(String(rq.j?.text ?? ''))}`);
    }
    await ed.fill('textarea[aria-label="정책 JSON"]', JSON.stringify(v1, null, 2));
    await ed.click('button:has-text("검증만")');
    await ed.locator('section[aria-label="정책 업로드"]', { hasText: '검증 완료' }).waitFor({ timeout: 15000 });
    const dryMsg = await ed.locator('section[aria-label="정책 업로드"]').innerText();
    check('PS3 화면 "검증만": 견적 가능한 정책으로 판정, DB 저장 없음', dryMsg.includes('검증 완료 — 견적 가능한 정책') && (await rowsOf(UI)).length === 0, dryMsg.slice(0, 80));
    await Promise.all([ed.waitForNavigation({ waitUntil: 'networkidle' }), ed.click('button:has-text("초안 저장")')]);
    const [d1] = await rowsOf(UI);
    const same = d1 && canon(d1.terms) === canon(v1.terms) && d1.product_label === v1.productLabel
      && new Date(d1.valid_from).toISOString() === v1.validFrom && new Date(d1.valid_until).toISOString() === v1.validUntil;
    check('PS4 화면 "초안 저장" → DB draft 1건, 원본 정책표(JSON)와 DB 값 완전 일치(요금·약정·장비·설치·결합·지역·사은품·지급/환수 조건·유효기간·상품명)', d1?.state === 'draft' && same === true,
      `state=${d1?.state} terms=${d1 ? JSON.stringify(d1.terms).slice(0, 60) : '-'}`);
    check('PS5 작성자 기록 = 편집자, 화면 목록에 초안과 "검수 요청" 버튼 표시', d1?.created_by === '00000000-0000-4000-8000-000000000006' && (await row(ed, UI).locator('button:has-text("검수 요청")').count()) === 1);
    await Promise.all([ed.waitForNavigation({ waitUntil: 'networkidle' }), row(ed, UI).locator('button:has-text("검수 요청")').click()]);
    check('PS6 화면 "검수 요청" → DB submitted, 편집자 화면에는 승인 버튼 없음(대표 승인 대기)', (await rowsOf(UI))[0]?.state === 'submitted'
      && (await row(ed, UI).locator('button:has-text("승인")').count()) === 0 && (await row(ed, UI).innerText()).includes('대표 승인 대기'));
    const rv = await pageAs(reviewer);
    check('PS7 검토자 화면: 업로드 칸·승인 버튼·게시 버튼 없음(조회만)', (await rv.locator('textarea[aria-label="정책 JSON"]').count()) === 0
      && (await row(rv, UI).locator('button').count()) === 0 && (await rv.locator('section[aria-label="정책 게시 스위치"] button').count()) === 0);

    // ── 2. 대표 화면: 확인 5개 + 사유 → 승인 ──
    const ow = await pageAs(owner);
    const r = row(ow, UI);
    await r.locator('input[aria-label="사유"]').fill('가상 정책 화면 승인');
    const disabledBefore = await r.locator('button:has-text("승인")').isDisabled();
    for (const cb of await r.locator('input[type=checkbox]').all()) await cb.check();
    const a0 = await n(`select count(*)::int as n from core.audit_logs where action like 'policy.%'`);
    await Promise.all([ow.waitForNavigation({ waitUntil: 'networkidle' }), r.locator('button:has-text("승인")').click()]);
    const [ap1] = await rowsOf(UI);
    check('PS8 대표 화면 승인: 확인 5개 전엔 버튼 잠김, 승인 뒤 DB approved·승인자 = 대표·자기 승인 아님·확인 5개 저장·감사 증가',
      disabledBefore === true && ap1?.state === 'approved' && ap1.decided_by === '00000000-0000-4000-8000-000000000001' && ap1.self_approval === false
      && Object.values(ap1.checks ?? {}).filter((v) => v === true).length === 5 && (await n(`select count(*)::int as n from core.audit_logs where action like 'policy.%'`)) > a0, `state=${ap1?.state}`);
    // ── 3. 게시 OFF면 고객 금액 없음 → 대표 화면 게시 ON → 반영 ──
    await sql.unsafe(`update core.feature_flags set enabled = false where key = 'policy_publish'`);
    const off = await ask(UI);
    check('PS9 승인됐어도 게시 OFF면 고객 상담에 금액 없음', off.status === 200 && !NUM.test(off.text) && !off.text.includes('27,700'));
    await ow.reload({ waitUntil: 'networkidle' });
    await ow.fill('input[aria-label="게시 변경 사유"]', '가상 정책 게시 시험');
    await Promise.all([ow.waitForNavigation({ waitUntil: 'networkidle' }), ow.click('section[aria-label="정책 게시 스위치"] button:has-text("게시 켜기")')]);
    const on = await ask(UI);
    check('PS10 대표 화면 "게시 켜기" → DB 스위치 ON, 고객 상담에 승인 원본 금액(27,700원·사은품 5,500원) 반영', (await flag()) === true && on.text.includes('27,700') && on.text.includes('5,500'), on.text.slice(0, 120));

    // ── 4. 새 버전 교체: 이전 버전·감사 보존, 고객은 새 금액만 ──
    const pol = (c, body, p = '/api/admin/policies') => adm(p, c, { method: 'POST', body: JSON.stringify(body) });
    const v2 = src(UI, 29_900, 6_600);
    const c2 = await pj(await pol(editor, v2));
    await pol(editor, { action: 'submit' }, `/api/admin/policies/${c2.id}`);
    const ok2 = await pol(owner, { action: 'approve', reason: '가상 정책 2판 승인', checks: CHK }, `/api/admin/policies/${c2.id}`);
    const rows2 = await rowsOf(UI);
    const ans2 = await ask(UI);
    check('PS11 새 버전 승인: 이전 승인본은 지우지 않고 superseded(값 그대로·교체 시각 기록), 새 버전 approved, 승인본은 1개뿐',
      ok2.status === 200 && rows2.length === 2 && rows2[0].state === 'superseded' && rows2[0].superseded_at !== null && canon(rows2[0].terms) === canon(v1.terms)
      && rows2[1].state === 'approved' && rows2.filter((x) => x.state === 'approved').length === 1, rows2.map((x) => x.state).join(','));
    check('PS12 고객 상담은 새 버전 금액(29,900원)만, 이전 금액(27,700원) 없음', ans2.text.includes('29,900') && !ans2.text.includes('27,700'), ans2.text.slice(0, 120));
    const aud = await n(`select count(*)::int as n from core.audit_logs where action like 'policy.%' and target_id in ('${rows2[0].id}', '${rows2[1].id}')`);
    check('PS13 감사 로그: 두 버전 모두 기록 남음(작성·제출·승인), 기존 감사 행 불변', aud >= 6 && (await auditOld()) === auditH0, `audit=${aud}`);

    // ── 5. 동시 승인: 같은 제출본에 대표 승인 2건 동시 → 1건만 성공 ──
    const c3 = await pj(await pol(editor, src(UI, 31_100, 7_700)));
    await pol(editor, { action: 'submit' }, `/api/admin/policies/${c3.id}`);
    const ap0 = await n(`select count(*)::int as n from core.audit_logs where action = 'policy.approve'`);
    const both = await Promise.all([1, 2].map((i) => pol(owner, { action: 'approve', reason: `동시 승인 ${i}`, checks: CHK }, `/api/admin/policies/${c3.id}`)));
    const rows3 = await rowsOf(UI);
    check('PS14 동시 승인 2건: 200은 1건, 나머지는 거부(4xx), DB 승인본 1개·승인 감사 +1(중복 승인 없음)',
      both.filter((x) => x.status === 200).length === 1 && both.every((x) => x.status === 200 || (x.status >= 400 && x.status < 500))
      && rows3.filter((x) => x.state === 'approved').length === 1 && (await n(`select count(*)::int as n from core.audit_logs where action = 'policy.approve'`)) === ap0 + 1,
      both.map((x) => x.status).join(','));

    // ── 6. 만료: 승인·게시돼도 유효기간이 지나면 고객 금액 없음 ──
    const EXP = 'next-e2e-ui2';
    const c4 = await pj(await pol(editor, src(EXP, 33_300, 8_800, 25_000)));
    await pol(editor, { action: 'submit' }, `/api/admin/policies/${c4.id}`);
    const ok4 = await pol(owner, { action: 'approve', reason: '만료 시험 가상 정책', checks: CHK }, `/api/admin/policies/${c4.id}`);
    const live4 = await ask(EXP);
    const until = new Date((await rowsOf(EXP))[0]?.valid_until ?? Date.now()).getTime();
    await new Promise((res) => setTimeout(res, Math.max(0, until - Date.now()) + 1500));
    const exp4 = await ask(EXP);
    check('PS15 만료: 유효기간 안에는 금액 안내, 지나면 승인·게시 상태여도 금액 미노출', ok4.status === 200 && live4.text.includes('33,300') && exp4.status === 200 && !exp4.text.includes('33,300') && !NUM.test(exp4.text),
      `${live4.text.slice(0, 40)} / ${exp4.text.slice(0, 40)}`);

    // ── 7. 대표 화면 게시 끄기 → 즉시 미노출 ──
    await ow.reload({ waitUntil: 'networkidle' });
    await ow.fill('input[aria-label="게시 변경 사유"]', '가상 정책 게시 종료');
    await Promise.all([ow.waitForNavigation({ waitUntil: 'networkidle' }), ow.click('section[aria-label="정책 게시 스위치"] button:has-text("게시 끄기")')]);
    const off2 = await ask(UI);
    check('PS16 대표 화면 "게시 끄기" → DB OFF, 고객 금액 즉시 미노출', (await flag()) === false && !NUM.test(off2.text));
  } finally {
    await br.close();
    await sql.unsafe(`update core.feature_flags set enabled = ${flag0 === true} where key = 'policy_publish'`);
  }
  // ── 8. 정리·불변: 다른 정책 행·기존 감사 행·게시 스위치 ──
  const others1 = await snapOthers();
  check('PS17 다른 정책(기존 데이터) 행 수·내용 불변, 기존 감사 행 불변, 게시 스위치 원래 값 복구, AI 사용료 0건',
    others1.c === others0.c && others1.h === others0.h && (await auditOld()) === auditH0 && (await flag()) === (flag0 === true) && (await n(`select count(*)::int as n from core.ai_usage_ledger`)) === 0,
    `${others0.c}/${others1.c}`);
}
