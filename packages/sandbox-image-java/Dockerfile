# Section 36 — sandbox-image-java
#
# Curated JDK 21 sandbox image. eclipse-temurin:21-alpine base — Java
# 11+ supports running .java source files directly with `java <File>.java`,
# so snippet mode does not require a separate javac step.
#
# Defaults applied by the sandbox layer at runtime:
#   --network=none --memory=512m --cpus=1.0 --read-only --tmpfs /tmp
#   --security-opt=no-new-privileges
#
# Layer R8.

FROM eclipse-temurin:21-alpine AS runtime

# JVM tuning for snippet mode: container memory awareness, smaller initial
# heap. Sandbox callers may override via `-J<flag>` extension at exec time.
ENV JAVA_TOOL_OPTIONS="-XX:+UseContainerSupport -XX:MaxRAMPercentage=50.0 -Xss512k"

RUN apk update \
 && apk add --no-cache ca-certificates tzdata \
 && rm -rf /var/cache/apk/* \
 && addgroup -S sbx && adduser -S -G sbx sbx \
 && mkdir -p /home/sbx /tmp/java \
 && chown -R sbx:sbx /home/sbx /tmp/java

USER sbx
WORKDIR /home/sbx

HEALTHCHECK --interval=30s --timeout=2s --retries=2 \
    CMD ["java", "-version"]

CMD ["java", "-version"]
