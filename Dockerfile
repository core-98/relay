FROM node:22-alpine AS base

ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

FROM base AS dependencies

RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS builder

COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build:node

FROM base AS runner

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=10000

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 10000

CMD ["node", "server.js"]
