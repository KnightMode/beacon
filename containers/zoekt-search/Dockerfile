FROM golang:1.25.9-bookworm AS zoekt
ARG ZOEKT_VERSION=v0.0.0-20260605122240-893a523804f1
RUN go install github.com/sourcegraph/zoekt/cmd/zoekt-webserver@${ZOEKT_VERSION}

FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates bash rclone \
  && rm -rf /var/lib/apt/lists/*

COPY --from=zoekt /go/bin/zoekt-webserver /usr/local/bin/zoekt-webserver
COPY startup.sh /startup.sh
RUN chmod +x /startup.sh

EXPOSE 6070
CMD ["/startup.sh"]
