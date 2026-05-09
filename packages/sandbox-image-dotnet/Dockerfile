# Section 36 — sandbox-image-dotnet
#
# Curated .NET 8 sandbox image. mcr.microsoft.com/dotnet/sdk:8.0-alpine
# (sdk, not just runtime — `dotnet script` requires the SDK + the
# globally-installed `dotnet-script` tool for snippet mode).
#
# Defaults applied by the sandbox layer at runtime:
#   --network=none --memory=512m --cpus=1.0 --read-only --tmpfs /tmp
#   --security-opt=no-new-privileges
#
# Cold-start budget is more generous (≤4s) to account for the .NET
# runtime warmup and dotnet-script's first-run JIT overhead.
#
# Layer R8.

FROM mcr.microsoft.com/dotnet/sdk:8.0-alpine AS runtime

ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NOLOGO=1 \
    DOTNET_RUNNING_IN_CONTAINER=true \
    DOTNET_USE_POLLING_FILE_WATCHER=true \
    DOTNET_GENERATE_ASPNET_CERTIFICATE=false \
    NUGET_PACKAGES=/tmp/nuget \
    DOTNET_TOOLS_DIR=/usr/local/dotnet-tools

# Install dotnet-script for snippet mode. The tool is installed into
# DOTNET_TOOLS_DIR so it's reachable at /usr/local/dotnet-tools/dotnet-script
# without needing a PATH entry under the sbx user's HOME.
RUN apk update \
 && apk add --no-cache ca-certificates icu-libs \
 && rm -rf /var/cache/apk/* \
 && dotnet tool install -g dotnet-script --tool-path /usr/local/dotnet-tools \
 && addgroup -S sbx \
 && adduser -S -G sbx sbx \
 && mkdir -p /home/sbx /tmp/nuget /tmp/dotnet \
 && chown -R sbx:sbx /home/sbx /tmp/nuget /tmp/dotnet

ENV PATH="/usr/local/dotnet-tools:${PATH}"

USER sbx
WORKDIR /home/sbx

HEALTHCHECK --interval=30s --timeout=4s --retries=2 \
    CMD ["dotnet", "--version"]

CMD ["dotnet", "--version"]
