FROM node:20-alpine AS builder

WORKDIR /app

ARG VITE_API_BASE
ENV VITE_API_BASE=${VITE_API_BASE}

COPY web-ui/package.json ./package.json
RUN npm install

COPY web-ui ./
RUN npm run build

FROM nginx:1.27-alpine

COPY web-ui/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 8001
