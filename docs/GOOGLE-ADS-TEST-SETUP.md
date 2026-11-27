# Google Ads 테스트 계정 검증 준비 (제이님용)

목적: 실제 광고·광고비 없이 **테스트 계정**에서만 연결과 설정이 맞는지 확인합니다.
도구: 저장소의 `scripts/google-ads-probe/`(이미 있는 진단 스크립트). 새 프로그램은 필요 없습니다.

## 1. 이 진단이 하는 일과 하지 않는 일

| 순서 | 하는 일 | 바뀌는 것 |
|---|---|---|
| ① | 필요한 설정 이름 4개가 있는지 확인(없으면 이름만 보여 주고 끝) | 없음 |
| ② | Google 로그인 토큰 받기 | 없음 |
| ③ | 계정 읽기: 통화(KRW?), 테스트 계정인지, 관리자 계정인지 | 없음(읽기만) |
| ④ | **테스트 계정이고 관리자 계정이 아닐 때만** "검증만(validateOnly)" 요청 1회 | **없음** — Google이 검사만 하고 아무것도 만들지 않음 |

- 실제 캠페인 생성·수정·게시, 광고비 지출은 **하지 않습니다**. 테스트 계정이 아니면 ④를 건너뜁니다.
- 화면에는 단계·결과·Google 오류코드·통화만 나옵니다. 비밀번호 같은 값(클라이언트 보안 비밀, 토큰, 고객 ID)은 나오지 않습니다.
- 유료 서비스를 켤 필요가 없습니다. Google Cloud **결제(카드) 등록이나 유료 기능 활성화는 하지 마세요**(이 진단에 필요 없음).

## 2. 제이님이 준비할 계정 (처음 한 번)

> Google 공식 정책(2026-09-09부터): **developer token은 더 이상 필요 없습니다.** 접근 권한은 아래 Google Cloud 프로젝트가 정합니다. 새 프로젝트는 처음에 "Test Account access"(테스트 계정만 호출 가능)입니다 — 이번 검증에는 이것으로 충분합니다.

**가. Google 계정 하나(가능하면 테스트 전용)**
- 실제 광고 관리자 계정과 연결되지 않은 Google 계정을 쓰는 것이 안전합니다(공식 문서도 테스트 관리자 계정은 운영 관리자와 연결되지 않은 계정으로 만들라고 안내).

**나. Google Ads 테스트 관리자 계정 + 테스트 고객 계정**
1. Google Ads API 문서의 "Test accounts" 페이지에서 **테스트 관리자 계정** 가입으로 들어갑니다.
2. 사업자 정보 입력 → 화면에 빨간 **"Test account"** 표시가 있는지 확인합니다.
3. 테스트 관리자 화면의 "계정(Accounts)"에서 **고객 계정**을 하나 만듭니다(여기서 만든 계정은 자동으로 테스트 계정). 통화는 **KRW(대한민국 원)** 로 고르세요.
4. 숫자 10자리 ID 두 개를 적어 둡니다: **고객 계정 ID**(= `GOOGLE_ADS_CUSTOMER_ID`), **테스트 관리자 ID**(= `GOOGLE_ADS_LOGIN_CUSTOMER_ID`).
- 테스트 계정은 광고가 실제로 나가지 않아 비용이 생기지 않습니다. 1년 동안 사용·로그인이 없으면 Google이 지웁니다.

**다. Google Cloud 프로젝트**
1. Google Cloud Console에서 새 프로젝트를 만듭니다(무료).
2. "API 및 서비스 → 라이브러리"에서 **Google Ads API** 를 사용 설정합니다.
3. "OAuth 동의 화면": 사용자 유형 **외부**, 게시 상태 **테스트**로 두고, **테스트 사용자**에 나.의 Google 계정을 추가합니다.
4. "사용자 인증 정보 → OAuth 클라이언트 ID 만들기": 유형 **웹 애플리케이션**, 승인된 리디렉션 URI에 `https://developers.google.com/oauthplayground` 추가.
   → **클라이언트 ID**(= `GOOGLE_ADS_CLIENT_ID`)와 **클라이언트 보안 비밀**(= `GOOGLE_ADS_CLIENT_SECRET`)이 나옵니다.

**라. 리프레시 토큰 받기(Google OAuth Playground, 공식 안내 방식)**
1. `https://developers.google.com/oauthplayground` 접속 → 오른쪽 위 톱니바퀴 → **Use your own OAuth credentials** 체크 → OAuth flow **Server-side**, Access type **Offline** → 다.의 클라이언트 ID·보안 비밀 입력.
2. Step 1에서 범위 `https://www.googleapis.com/auth/adwords` 입력 → **Authorize APIs** → 나.의 Google 계정으로 로그인·허용.
3. Step 2에서 **Exchange authorization code for tokens** → **Refresh token**(= `GOOGLE_ADS_REFRESH_TOKEN`)을 복사합니다.
4. 끝나면 다.의 OAuth 클라이언트에서 Playground 리디렉션 URI를 지워도 됩니다(최소 1개는 남겨야 함).
- 참고(미검증): 동의 화면이 "테스트" 상태면 리프레시 토큰이 7일 뒤 만료될 수 있습니다. 진단이 `oauth.invalid_grant`로 실패하면 라.를 다시 하세요.

> 이 값 4~5개는 **어디에도 붙여 넣지 마세요**(채팅·GitHub·문서·파일 모두). 아래처럼 Mac 터미널에 직접 입력만 합니다.

## 3. Mac mini에서 실행 (최소 절차)

**처음 한 번 — 설치**
1. Node.js 22 이상 설치: `https://nodejs.org` 에서 LTS(22 이상) macOS 설치 파일을 받아 설치. 확인: 터미널에서 `node -v` → `v22` 이상.
2. 저장소 받기와 의존성 설치(무료):
   ```bash
   cd ~
   git clone https://github.com/git384291/go.git fideon-go
   cd fideon-go
   git checkout phase1-product-scope
   npm ci
   ```

**실행할 때마다 — 값 입력(화면·기록에 남지 않게)**
```bash
cd ~/fideon-go
read -rs GOOGLE_ADS_CLIENT_ID && export GOOGLE_ADS_CLIENT_ID
read -rs GOOGLE_ADS_CLIENT_SECRET && export GOOGLE_ADS_CLIENT_SECRET
read -rs GOOGLE_ADS_REFRESH_TOKEN && export GOOGLE_ADS_REFRESH_TOKEN
read -rs GOOGLE_ADS_CUSTOMER_ID && export GOOGLE_ADS_CUSTOMER_ID
read -rs GOOGLE_ADS_LOGIN_CUSTOMER_ID && export GOOGLE_ADS_LOGIN_CUSTOMER_ID
```
- 각 줄을 입력하면 화면에 아무것도 안 보이는 상태로 기다립니다. 값을 붙여 넣고 Enter를 누르세요(글자가 안 보이는 것이 정상).
- 값은 이 터미널 창을 닫으면 사라집니다. 파일로 저장하지 마세요.

**진단 실행**
```bash
node --conditions=react-server --import tsx scripts/google-ads-probe/run.mts; echo "종료 코드: $?"
```

**실계정 읽기 전용 점검(PM 11/25, 바른통신 ①~④)** — 변경 0회. 캠페인·예산·상태·최근 30일 실적·키워드 예상 CPC만 읽습니다.
```bash
read -rs GOOGLE_ADS_MONTHLY_CAP_KRW && export GOOGLE_ADS_MONTHLY_CAP_KRW   # 월 광고비 하드 한도(원, 숫자만). 비우면 "집행 차단"으로 표시
node --conditions=react-server --import tsx scripts/google-ads-probe/liveread.mts; echo "종료 코드: $?"
```
- 종료 코드: 0 확인 완료 · 2 설정 없음 · 3 인증·권한·조회 실패(오류코드만 표시) · 5 ENABLED 캠페인 발견(바꾸지 않음) · 6 실적 중복·합계 불일치
- 출력 JSON 줄을 그대로 Claude에게 붙여 넣으면 됩니다(토큰·고객 ID·캠페인 ID는 출력되지 않음).

**값 지우기(끝나면)**
```bash
unset GOOGLE_ADS_CLIENT_ID GOOGLE_ADS_CLIENT_SECRET GOOGLE_ADS_REFRESH_TOKEN GOOGLE_ADS_CUSTOMER_ID GOOGLE_ADS_LOGIN_CUSTOMER_ID GOOGLE_ADS_MONTHLY_CAP_KRW
```

## 4. 결과 읽는 법

출력은 JSON 줄 몇 개입니다. 이 출력은 비밀이 없으므로 **그대로 복사해 Claude/PM에게 전달**해도 됩니다.

| 종료 코드 | 뜻 | 다음 할 일 |
|---|---|---|
| 0 | 테스트 계정 확인 + 검증만 요청 통과 | 결과 전달 |
| 2 | 설정 값이 없거나 형식이 틀림(`missing`/`invalid`에 이름만 표시) | 3.의 입력 다시 |
| 3 | 로그인 또는 계정 읽기 실패(`googleErrorCodes` 참고) | 오류코드 전달 |
| 4 | 테스트 계정이 아니거나 관리자 계정 → **변경 요청을 보내지 않고 멈춤** | 고객 ID가 테스트 **고객** 계정인지 확인 |
| 5 | 검증만 요청이 거절됨(`googleErrorCodes`에 이유) | 오류코드 전달 |

- `account_read` 줄의 `"krw": true` 이면 계정 통화가 원화입니다.
- 자주 보일 수 있는 오류코드: `oauth.invalid_grant`(토큰 만료·잘못됨 → 2-라 다시), `authorizationError.USER_PERMISSION_DENIED`(그 Google 계정이 고객 계정에 권한 없음 또는 login ID 누락), `authorizationError.CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION`(테스트 권한 프로젝트로 실제 계정을 호출 → 테스트 계정 ID를 쓰세요).

## 5. 아직 확인되지 않은 것

- 실제 테스트 계정에서의 실행 결과(접근 수준, KRW, 검증 결과, 오류코드) — 제이님 실행 후 확인.
- Cloud 프로젝트 접근 수준 이름(Test/Explorer 등)은 API가 직접 알려 주지 않습니다. 읽기 성공 여부와 오류코드로 판단합니다.
- 리프레시 토큰 7일 만료(동의 화면 "테스트" 상태) — Google OAuth 일반 정책으로 알려져 있으나 Google Ads 문서에서 직접 확인하지 못함.
- Google 화면 메뉴 이름은 바뀔 수 있습니다.
