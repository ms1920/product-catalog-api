# Multi-stage: the toolchain that compiles TypeScript has no business shipping to
# production. The runtime stage carries production dependencies and dist/ only.

FROM node:22-alpine AS deps
WORKDIR /app
# Copying the manifests alone means this layer is cached until dependencies
# actually change, rather than on every source edit.
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
# --omit=dev drops typescript, vitest and eslint from the image.
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# PGlite needs somewhere writable when DATABASE_URL is unset. Owned by node so
# the process does not need root to use it.
RUN mkdir -p /app/.data && chown -R node:node /app/.data

# Run unprivileged. A container escape from a root process is a host compromise.
USER node

EXPOSE 3000

# Checks readiness, not liveness: /ready runs a real query, so an orchestrator
# never routes traffic to a process whose database is not answering.
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
