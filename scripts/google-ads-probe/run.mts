// 사용(로컬 PC에서만, credential은 로컬 환경변수로만):
//   GOOGLE_ADS_CLIENT_ID=… GOOGLE_ADS_CLIENT_SECRET=… GOOGLE_ADS_REFRESH_TOKEN=… GOOGLE_ADS_CUSTOMER_ID=… \
//   node --conditions=react-server --import tsx scripts/google-ads-probe/run.mts
// 출력은 JSON 줄(단계·HTTP·Google 오류코드·통화·불리언)뿐. 테스트 계정이 아니면 변경 호출 없이 끝난다(종료 코드 4).
import { runProbe, type ProbeTransport } from './core.ts';

const MAX = 64 * 1024;
const transport: ProbeTransport = async (url, init) => {
  try {
    const r = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    const text = (await r.text()).slice(0, MAX);
    return { status: r.status, text };
  } catch {
    return { status: 0, text: '' }; // 전송 실패·시간 초과(원문 출력 안 함)
  }
};
const code = await runProbe(process.env, transport, (l) => console.log(JSON.stringify(l)));
process.exit(code);
