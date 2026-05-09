# Section 36 — sandbox-image-r
#
# Curated R 4.x sandbox image. rocker/r-base trimmed to ~150 MB with
# the common analyst-style packages (tidyverse, data.table) baked in
# so snippet-mode runs don't need package installs. `Rscript -e <code>`
# is the snippet entrypoint.
#
# Defaults applied by the sandbox layer at runtime:
#   --network=none --memory=512m --cpus=1.0 --read-only --tmpfs /tmp
#   --security-opt=no-new-privileges
#
# Layer R8.

FROM rocker/r-base:4.4 AS runtime

ENV R_LIBS_USER=/usr/local/lib/R/site-library \
    R_DEFAULT_PACKAGES="stats,methods,utils,grDevices,graphics,datasets,tidyverse,data.table"

# Pre-install the analyst-side standard library. We use BSPM for binary
# package install (faster than source compile) where available. Strip
# build dependencies after the install to keep the image compact.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        ca-certificates \
        r-cran-tidyverse \
        r-cran-data.table \
 && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Non-root user (the rocker base ships with a `docker` user; we add
# our own `sbx` to match the §36 convention).
RUN useradd -m -s /bin/sh sbx \
 && mkdir -p /home/sbx /tmp/r-snippets \
 && chown -R sbx:sbx /home/sbx /tmp/r-snippets

USER sbx
WORKDIR /home/sbx

HEALTHCHECK --interval=30s --timeout=2s --retries=2 \
    CMD ["Rscript", "-e", "cat(R.version.string)"]

CMD ["Rscript", "-e", "cat(R.version.string)"]
