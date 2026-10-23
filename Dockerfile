FROM docker.io/library/node:20-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY public ./public
# The cluster enforces runAsNonRoot; use the image's numeric non-root user.
USER 1000
EXPOSE 8080
CMD ["node", "src/server.js"]
