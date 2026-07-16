FROM alpine AS builder

RUN apk add --no-cache nodejs npm python3

WORKDIR /build

RUN npm set prefix=/build

RUN npm_config_build_from_source=true npm install --omit dev homebridge homebridge-dyson-pure-cool

# Build and install the local Shirokuma AC (airCloud Home) plugin from source.
# It is not published to npm, so compile it and drop the built output (plus its
# production deps) into homebridge's node_modules where homebridge discovers it.
# No lockfile / no pinning: always pull the latest packages at build time.
COPY homebridge-aircloudhome /src/homebridge-aircloudhome
# eslint + typescript-eslint are lint-only tooling and are not needed to compile
# the plugin (build = rimraf + tsc). They also cap the TypeScript peer below the
# current latest (TS 7), which breaks "always latest" installs with ERESOLVE.
# Drop them from the in-image package.json so the build pulls latest typescript.
RUN cd /src/homebridge-aircloudhome \
    && rm -f package-lock.json \
    && npm pkg delete devDependencies.eslint \
        "devDependencies.@typescript-eslint/eslint-plugin" \
        "devDependencies.@typescript-eslint/parser" \
    && npm install \
    && npm install axios@latest \
    && npm install --save-dev typescript@latest rimraf@latest \
    && npm run build \
    && npm prune --omit=dev \
    && mkdir -p /build/node_modules/homebridge-aircloudhome \
    && cp -r dist package.json config.schema.json README.md node_modules \
        /build/node_modules/homebridge-aircloudhome/ \
    && rm -rf /src/homebridge-aircloudhome

FROM alpine

RUN apk add --no-cache nodejs

COPY --from=builder /build /app

VOLUME /config

CMD [ "/app/node_modules/homebridge/bin/homebridge.js", "-U", "/config" ]

