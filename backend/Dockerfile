FROM node:22-slim

# yaz-client (the YAZ Z39.50 toolkit's CLI) is required at runtime by
# src/services/z3950Lookup.js to query the Library of Congress's Z39.50
# catalog. It's an OS package, not an npm package -- Render's native Node
# buildpack has no way to run apt-get, which is why this service needs to
# be deployed as a Docker service instead of a plain Node one. See the PR
# that introduced this file for the full tradeoff writeup.
RUN apt-get update \
    && apt-get install -y --no-install-recommends yaz \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 10000

CMD ["node", "src/server.js"]
