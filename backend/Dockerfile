FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    API_BIND_HOST=127.0.0.1

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY --chown=node:node . .
USER node

EXPOSE 3000
CMD ["node", "src/server.js"]
