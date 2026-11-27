// 실계정 연결 확인(읽기 전용) — 로컬 PC에서 사람이 직접 실행한다. CI·서버는 실행하지 않는다.
// 사용: cd ~/FIDEON && node --conditions=react-server --import tsx scripts/google-ads-probe/ask.mts
// - 인증 정보 4종을 화면에 안 보이게 직접 입력받는다. 명령줄·환경변수·파일·기록에 남기지 않는다(이 프로세스 메모리에서만 쓰고 끝나면 사라짐).
// - 읽기 전용 모드로만 실행: OAuth 토큰 발급 → 계정 조회(통화·테스트 계정·관리자 여부)까지. 변경 API(validateOnly 포함) 0회, 광고 생성·지출 없음.
// - 출력은 단계·HTTP 상태·Google 오류코드·통화·불리언뿐(core.ts와 같음). 입력값·토큰·고객 ID는 출력하지 않는다.
import { runProbe, type ProbeTransport } from './core.ts';

const MAX = 64 * 1024;
const transport: ProbeTransport = async (url, init) => {
  if (!/^https:\/\/(oauth2\.googleapis\.com\/token|googleads\.googleapis\.com\/v\d{2}\/customers\/\d{1,20}\/googleAds:search)$/.test(url)) return { status: 0, text: '' }; // 읽기 주소 2곳 외 전송 안 함
  try {
    const r = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    return { status: r.status, text: (await r.text()).slice(0, MAX) };
  } catch {
    return { status: 0, text: '' };
  }
};

function ask(label: string): Promise<string> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) { process.stdout.write('FAILED: NOT_A_TERMINAL\n'); process.exit(2); }
    process.stdout.write(label);
    let s = '';
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
    const on = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\u0003') { process.stdout.write('\n'); process.exit(130); }
        if (ch === '\r' || ch === '\n') { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', on); process.stdout.write('\n'); return resolve(s.trim()); }
        if (ch === '\u007f' || ch === '\b') s = s.slice(0, -1); else if (ch >= ' ') s += ch;
      }
    };
    process.stdin.on('data', on);
  });
}

process.stdout.write('입력값은 화면에 보이지 않습니다. 붙여넣은 뒤 Enter.\n');
const env = {
  GOOGLE_ADS_CLIENT_ID: await ask('OAuth Client ID: '),
  GOOGLE_ADS_CLIENT_SECRET: await ask('OAuth Client Secret: '),
  GOOGLE_ADS_REFRESH_TOKEN: await ask('Refresh Token: '),
  GOOGLE_ADS_CUSTOMER_ID: await ask('광고 계정 고객 ID(10자리, 하이픈 가능): '),
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: (await ask('관리자 계정 ID(없으면 그냥 Enter): ')) || undefined,
  GOOGLE_ADS_PROBE_READ_ONLY: 'true',
};
const code = await runProbe(env, transport, (l) => console.log(JSON.stringify(l)));
process.exit(code);
