FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json .
RUN npm install
COPY . .
# Production WebSocket endpoint — baked into the bundle at build time.
# Override per deploy via docker-compose build args or `--build-arg`.
ARG VITE_BACKEND_WS_URL=""
ENV VITE_BACKEND_WS_URL=$VITE_BACKEND_WS_URL
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
