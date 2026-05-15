FROM node:20-slim

# @roamhq/wrtc needs native build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json .
RUN npm install

COPY . .

EXPOSE 3001
CMD ["node", "server-ultravox.js"]
