FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /repo/services/orders-service
COPY services/orders-service/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY shared /repo/shared
COPY services/orders-service/src ./src
USER node
EXPOSE 3002
CMD ["node", "src/server.js"]
