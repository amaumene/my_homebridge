FROM alpine AS builder

RUN apk add --no-cache nodejs npm python3

WORKDIR /build

RUN npm set prefix=/build

RUN npm install --omit dev --build-from-source homebridge homebridge-dyson-pure-cool homebridge-dummy

FROM alpine

RUN apk add --no-cache nodejs

COPY --from=builder /build /app

VOLUME /config

CMD [ "/app/node_modules/homebridge/bin/homebridge", "-U", "/config" ]
