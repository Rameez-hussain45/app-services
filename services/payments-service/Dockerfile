FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /repo/services/payments-service
COPY shared /repo/shared
COPY services/payments-service/src ./src
USER node
EXPOSE 3003
CMD ["node", "src/server.js"]
