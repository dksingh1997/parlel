# Parlel — 250+ service emulators, one dependency-free Node image.
FROM node:24-slim

WORKDIR /app

# The emulators + launcher are pure Node (no npm install needed).
COPY services ./services
COPY src ./src

# Default: start a small useful set. Override with -e SERVICES="a,b,c" or SERVICES=all.
ENV SERVICES="postgres,redis"

ENTRYPOINT ["node", "src/launch.mjs"]
