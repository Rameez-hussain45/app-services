FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /repo/services/api-gateway
COPY shared /repo/shared
COPY services/api-gateway/src ./src
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
