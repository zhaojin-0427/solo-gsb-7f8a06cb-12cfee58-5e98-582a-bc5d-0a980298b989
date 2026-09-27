FROM node:20-alpine

WORKDIR /app

# 仅依赖清单，优先利用构建缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --cache /tmp/npm-cache && rm -rf /tmp/npm-cache

# 拷贝应用代码
COPY server.js ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

USER node
CMD ["node", "server.js"]
