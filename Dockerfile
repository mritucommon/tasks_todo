# Task List — Live. For self-hosting on a persistent host (Railway/Render/Fly).
# On Vercel you don't use this file; see README "Deploy to Vercel".
FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

ENV NODE_ENV=production
# Uses a local SQLite file by default; set TURSO_DATABASE_URL to use Turso instead.
ENV TASKLIST_DB=/data/tasklist.db
VOLUME /data

ENV PORT=4000
EXPOSE 4000

CMD ["node", "server/server.js"]
