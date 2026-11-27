# 바른365 Cloud Run 이미지 (Next.js standalone). 실제 배포·비밀 입력은 승인 뒤 별도 절차(docs/cloud-run.md).
# - 비밀 값은 이미지에 넣지 않는다(빌드 인자·ENV에 키 없음). 실행 시 Cloud Run 환경 변수/Secret Manager로만 주입.
# - 비루트 사용자, PORT=8080, 0.0.0.0 수신. K_SERVICE(Cloud Run 표준)가 있으면 앱이 운영으로 판정한다(src/server/env/deployEnv.ts).
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_OUTPUT=standalone
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8080 HOSTNAME=0.0.0.0
RUN groupadd --system --gid 10001 app && useradd --system --uid 10001 --gid app --no-create-home app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
USER app
EXPOSE 8080
CMD ["node", "server.js"]
