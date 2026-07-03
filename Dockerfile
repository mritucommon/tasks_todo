# Task List — Live. Zero runtime dependencies; uses Node's built-in SQLite.
FROM node:24-alpine

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public

ENV NODE_ENV=production
# Store the SQLite database on a persistent volume mounted at /data.
ENV TASKLIST_DB=/data/tasklist.db
VOLUME /data

# Hosts inject PORT; default to 4000 locally.
ENV PORT=4000
EXPOSE 4000

CMD ["node", "server/server.js"]
