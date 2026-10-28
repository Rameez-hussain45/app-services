FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /repo/services/users-service
COPY services/users-service/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY shared /repo/shared
COPY services/users-service/src ./src
USER node
EXPOSE 3001
CMD ["node", "src/server.js"]
