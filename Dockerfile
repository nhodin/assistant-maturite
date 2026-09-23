# Maturity Analyzer — image for a Home Assistant OS add-on, or any Docker host.
#
# Debian (glibc), not Alpine: the CloakBrowser stealth Chromium is a glibc build.
# Only CloakBrowser is used for capture — Playwright's bundled Chromium is NOT
# installed; the `playwright` package is only the driver cloakbrowser plugs into.
# Hard-coded on purpose: the HA Supervisor passes its own Alpine image as the
# BUILD_FROM build-arg, which must NOT be honoured here.
FROM docker.io/library/node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    TZ=Europe/Paris \
    # Chromium takes navigator.languages from these: without them the stealth
    # browser reports en-US from a French residential IP.
    LANG=fr_FR.UTF-8 \
    LANGUAGE=fr_FR:fr \
    # Headed escalation (2nd attempt) renders on this virtual display — see entrypoint.
    DISPLAY=:99 \
    # Stealth binary (~500 MB), license file and geoip DB live on the persistent
    # volume: downloaded once at first boot (Pro tier is resolved from the key at
    # that moment), kept across image rebuilds.
    CLOAKBROWSER_CACHE_DIR=/data/cloakbrowser \
    # Docker gives /dev/shm 64 MB, which crashes Chromium on heavy pages, and a HA
    # add-on cannot enlarge it. Make Chromium use /tmp instead.
    CLOAK_EXTRA_ARGS=--disable-dev-shm-usage \
    PORT=5173

WORKDIR /app

# System libraries Chromium needs, the Xvfb virtual display, fonts (CJK for the
# China pages, emoji), tini to reap Chromium's child processes, jq for the HA
# add-on options, and the MariaDB client for dumps/imports.
COPY package.json package-lock.json ./
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates openssl tini jq tzdata \
      xvfb xauth \
      fontconfig fonts-liberation fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
      mariadb-client \
 && npm ci --include=dev --no-audit --no-fund \
 && npx playwright install-deps chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
COPY data/*.csv ./data/
COPY deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
 && sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh

EXPOSE 5173
VOLUME ["/data"]

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
