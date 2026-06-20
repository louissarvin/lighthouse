# Lighthouse backend — Bun + Fastify + Prisma 7 (Railway / Docker)

FROM oven/bun:1.3-debian AS builder

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lockb ./

RUN bun install --frozen-lockfile

COPY prisma ./prisma
COPY index.ts dotenv.ts ./
COPY src ./src

# prisma.config.ts reads DATABASE_URL at load time; a dummy value is fine for generate.
ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build?schema=public"

RUN bunx prisma generate --config prisma/prisma.config.ts

FROM oven/bun:1.3-debian AS runner

WORKDIR /app

ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 1001 lighthouse \
  && useradd --system --uid 1001 --gid lighthouse lighthouse

COPY package.json bun.lockb ./

RUN bun install --frozen-lockfile --production

COPY --from=builder /app/prisma ./prisma
COPY index.ts dotenv.ts ./
COPY src ./src

RUN chown -R lighthouse:lighthouse /app

USER lighthouse

EXPOSE 3700

# Railway sets PORT; the app reads APP_PORT (see main-config.ts).
CMD ["sh", "-c", "APP_PORT=${PORT:-${APP_PORT:-3700}} exec bun run start"]
