FROM alpine AS builder

RUN apk add --no-cache nodejs npm python3

WORKDIR /build

RUN npm set prefix=/build

RUN npm install -g --omit dev homebridge homebridge-dyson-pure-cool

RUN find . -name "*.node" -exec rm -f {} \;

RUN npm rebuild --build-from-source

FROM alpine

RUN apk add --no-cache nodejs

COPY --from=builder /build /app

VOLUME /config

CMD [ "/app/bin/homebridge", "-U", "/config" ]
