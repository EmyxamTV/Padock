FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json vite.config.ts ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache su-exec
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/build ./build
COPY docker-entrypoint.sh /usr/local/bin/padock-entrypoint
RUN chmod +x /usr/local/bin/padock-entrypoint
EXPOSE 3000
ENTRYPOINT ["padock-entrypoint"]
CMD ["node", "build/server/index.js"]
