# The gateway (Next.js dashboard, REST API, WebSocket, MQTT to the printer). See docker-compose.gateway.yml.
FROM node:22-bookworm-slim

# openssl makes the self-signed HTTPS certificate on first start
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

# Claude Code: `claude -p` reviews timelapses and names a model's parts (on CLAUDE_CODE_OAUTH_TOKEN)
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

WORKDIR /app

COPY package.json package-lock.json ./
# Dev dependencies stay: `next build` needs TypeScript, and the server runs through tsx
RUN npm ci && npm cache clean --force

COPY . .
RUN npm run build && chown -R node:node /app

USER node
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npx", "tsx", "server.ts"]
