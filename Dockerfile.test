# syntax=docker/dockerfile:1

# Build stage for WebUI
FROM node:20-alpine AS webui-builder
WORKDIR /webui
COPY webui/package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm install --legacy-peer-deps
COPY webui/src ./src
COPY webui/assets ./assets
COPY webui/messages ./messages
COPY webui/project.inlang ./project.inlang
COPY webui/gen ./gen
COPY webui/*.ts webui/*.json webui/*.html ./
RUN npm run build

# Build stage for Go
FROM golang:1.26-alpine AS go-builder
RUN apk add --no-cache git
WORKDIR /app
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download
COPY . .
# Copy built webui to the location Go expects for embedding
COPY --from=webui-builder /webui/dist ./webui/dist
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go build -o /backrest ./cmd/backrest
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go build -o /docker-entrypoint ./cmd/docker-entrypoint

# Final stage
FROM alpine:latest
RUN apk --no-cache add tini ca-certificates curl bash rclone openssh tzdata docker-cli
WORKDIR /app
COPY --from=go-builder /backrest /backrest
COPY --from=go-builder /docker-entrypoint /docker-entrypoint

# Install restic dependency (cached)
RUN --mount=type=cache,target=/root/.local/share/backrest \
    /backrest --install-deps-only && \
    mkdir -p /bin && cp /root/.local/share/backrest/restic /bin/restic

ENTRYPOINT ["/sbin/tini", "--", "/docker-entrypoint"]
CMD ["/backrest"]
