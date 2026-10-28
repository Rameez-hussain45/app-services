FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /repo/services/frontend
COPY shared /repo/shared
COPY services/frontend/src ./src
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
