# CloseWord Party — Deno edition.
#
# For a container host that can keep a process alive: Railway, Render, Fly.io,
# Cloud Run, a VPS, your own Kubernetes. Not for Vercel — Vercel does not run
# Dockerfiles, and this app needs a long-lived process holding both a WebSocket
# per player and a 60 MB embedding table.
#
# The image contains no Claude integration, guaranteed three ways over:
#   1. the build stage runs `scripts/build_prod.ts`, which emits a tree with
#      `server/ai.ts` left out and refuses to emit if it finds a spawn call;
#   2. the `start` task in the emitted deno.json has no `--allow-run`, so the
#      process could not spawn anything even if the code tried;
#   3. that same task sets CLOSEWORD_AI=off.
# The banner reads `ai clues off (not built in)`.
#
#   docker build -t closeword .
#   docker run --rm -p 8791:8791 closeword
#
# See "Running in a container" in the README for the pack options below.

ARG DENO_VERSION=2.8.3

# ---------------------------------------------------------------------------
# build — emit the production tree, and optionally a pack to go in it
# ---------------------------------------------------------------------------

FROM denoland/deno:alpine-${DENO_VERSION} AS build
WORKDIR /app

COPY . .

RUN deno run --allow-read --allow-write --allow-env scripts/build_prod.ts --force

WORKDIR /app/dist

# The embedding pack is generated data rather than source, so it is not in the
# build context. Choose how this image gets one:
#
#   PACK=sample   (default) synthetic 64-d vectors, built in seconds. Boots and
#                 plays, and says [SAMPLE PACK] on every start. Fine for a smoke
#                 test, wrong for a real game — the vectors are invented, so the
#                 ranks mean nothing.
#   PACK=full     downloads real fastText vectors and builds the 50k pack now.
#                 Correct and self-contained; slow build, ~60 MB in the image.
#   PACK=none     no pack. The container refuses to start unless one is mounted
#                 at /app/data/vectors.bin — right when it lives on a volume.
ARG PACK=sample
RUN case "$PACK" in \
      sample) deno task ingest --sample ;; \
      full)   deno task ingest ;; \
      none)   echo "no pack baked in — mount one at /app/data/vectors.bin" ;; \
      *)      echo "PACK must be sample, full or none (got '$PACK')" >&2; exit 1 ;; \
    esac


# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------

FROM denoland/deno:alpine-${DENO_VERSION} AS runtime
WORKDIR /app

# Logs go to stdout only, where the platform collects them. Writing files would
# need a writable volume for no benefit, and this runs as a non-root user.
ENV HOST=0.0.0.0 \
    PORT=8791 \
    CLOSEWORD_LOG_TO_FILE=false \
    CLOSEWORD_LOG_CONSOLE=true

COPY --from=build --chown=deno:deno /app/dist ./

# The start task passes --env-file=.env. A missing file is only a warning, but
# an empty one keeps the boot log honest — every setting here comes from the
# environment.
RUN touch .env && chown deno:deno /app .env

USER deno

# Resolve and cache the jsr: dependencies now, so a container start does no
# network I/O and a broken dependency fails the build rather than the deploy.
RUN deno cache server/main.ts

EXPOSE 8791

# /healthz answers without touching game state, so it is safe to poll.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD deno eval --allow-net --allow-env "const r = await fetch('http://127.0.0.1:' + (Deno.env.get('PORT') ?? '8791') + '/healthz'); Deno.exit(r.ok ? 0 : 1)"

CMD ["deno", "task", "start"]
