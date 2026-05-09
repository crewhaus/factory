# Section 36 — sandbox-image-php
#
# Curated PHP 8.3 sandbox image. php:8.3-alpine base — `php -r <code>`
# is the snippet entrypoint; `php <file>.php` is the file mode. Composer
# is installed for callers who mount a project with a composer.json.
#
# Defaults applied by the sandbox layer at runtime:
#   --network=none --memory=512m --cpus=1.0 --read-only --tmpfs /tmp
#   --security-opt=no-new-privileges
#
# Layer R8.

FROM php:8.3-alpine AS runtime

# Install Composer from the official multi-stage builder image (verified
# binary). Strip apk metadata + composer cache after the install so the
# warm-pool image stays compact and re-installs are blocked.
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

ENV COMPOSER_ALLOW_SUPERUSER=0 \
    COMPOSER_HOME=/tmp/composer \
    COMPOSER_CACHE_DIR=/tmp/composer-cache \
    PHP_INI_DIR=/usr/local/etc/php

RUN apk update \
 && apk add --no-cache ca-certificates tzdata \
 && rm -rf /var/cache/apk/* \
 && addgroup -S sbx \
 && adduser -S -G sbx sbx \
 && mkdir -p /home/sbx /tmp/composer /tmp/composer-cache \
 && chown -R sbx:sbx /home/sbx /tmp/composer /tmp/composer-cache \
 && cp "${PHP_INI_DIR}/php.ini-production" "${PHP_INI_DIR}/php.ini" \
 && echo "expose_php=Off" >> "${PHP_INI_DIR}/php.ini" \
 && echo "max_execution_time=30" >> "${PHP_INI_DIR}/php.ini"

USER sbx
WORKDIR /home/sbx

HEALTHCHECK --interval=30s --timeout=2s --retries=2 \
    CMD ["php", "--version"]

CMD ["php", "--version"]
