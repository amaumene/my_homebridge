FROM alpine AS builder

RUN apk add --no-cache nodejs npm python3

WORKDIR /build

RUN npm set prefix=/build

RUN npm_config_build_from_source=true npm install --omit dev homebridge homebridge-dyson-pure-cool

FROM alpine

RUN apk add --no-cache nodejs

COPY --from=builder /build /app

VOLUME /config

CMD [ "/app/node_modules/homebridge/bin/homebridge.js", "-U", "/config" ]

