// 사용(로컬 PC에서만, Google Ads '테스트 계정' credential을 로컬 환경변수로만):
//   GOOGLE_ADS_PROBE_READBACK=test-account-only GOOGLE_ADS_CLIENT_ID=… GOOGLE_ADS_CLIENT_SECRET=… GOOGLE_ADS_REFRESH_TOKEN=… GOOGLE_ADS_CUSTOMER_ID=… \
//   node --conditions=react-server --import tsx scripts/google-ads-probe/readback.mts
// 테스트 계정·KRW·Asia/Seoul이 아니면 변경 호출 없이 끝난다(종료 4). 출력은 JSON 줄(단계·불리언·HTTP)뿐.
import { runReadback } from './readback.ts';
import type { BodyTransport } from '../../src/server/advertising/boundedHttp';

const transport: BodyTransport = async (url, init) => {
  const r = await fetch(url, init);
  return { status: r.status, body: r.body };
};
process.exit(await runReadback(process.env, transport, (l) => console.log(JSON.stringify(l))));
