# Section 36 — sandbox-image-ruby
#
# Curated Ruby 3.3 sandbox image. ruby:3.3-alpine base — `ruby -e <code>`
# is the snippet entrypoint; advanced callers can mount a project and
# invoke `ruby <file>.rb` after a `bundle install`.
#
# Defaults applied by the sandbox layer at runtime:
#   --network=none --memory=512m --cpus=1.0 --read-only --tmpfs /tmp
#   --security-opt=no-new-privileges
#
# Layer R8.

FROM ruby:3.3-alpine AS runtime

ENV BUNDLE_PATH=/tmp/bundle \
    BUNDLE_DISABLE_SHARED_GEMS=true \
    GEM_HOME=/tmp/gems \
    RUBY_YJIT_ENABLE=1

RUN apk update \
 && apk add --no-cache ca-certificates tzdata \
 && rm -rf /var/cache/apk/* \
 && addgroup -S sbx && adduser -S -G sbx sbx \
 && mkdir -p /home/sbx /tmp/bundle /tmp/gems \
 && chown -R sbx:sbx /home/sbx /tmp/bundle /tmp/gems

USER sbx
WORKDIR /home/sbx

HEALTHCHECK --interval=30s --timeout=2s --retries=2 \
    CMD ["ruby", "--version"]

CMD ["ruby", "--version"]
