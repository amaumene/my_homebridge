FROM alpine AS builder

RUN apk add --no-cache nodejs npm python3 make g++

WORKDIR /build

RUN npm set prefix=/build

RUN npm install -g --omit dev homebridge homebridge-dyson-pure-cool homebridge-config-ui-x

FROM alpine

RUN apk add --no-cache nodejs

COPY --from=builder /build /build

VOLUME /config

CMD [ "/build/bin/homebridge", "-U", "/config" ]
