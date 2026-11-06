FROM node:20-bookworm
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx vite build
ENV HOST=0.0.0.0 PORT=4100
EXPOSE 4100
CMD ["node", "--import", "tsx", "src/hub/main.ts"]
