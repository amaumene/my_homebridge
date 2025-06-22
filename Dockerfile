FROM alpine AS builder

RUN apk add --no-cache nodejs npm python3 make g++

WORKDIR /build

RUN npm set prefix=/build

RUN npm install -g --omit dev homebridge homebridge-dyson-pure-cool homebridge-config-ui-x @switchbot/homebridge-switchbot

#RUN find . -name "*.node" -exec rm -f {} \;

#RUN npm rebuild --build-from-source

FROM alpine

RUN apk add --no-cache nodejs

COPY --from=builder /build /app

VOLUME /config

CMD [ "/app/bin/homebridge", "-U", "/config" ]
