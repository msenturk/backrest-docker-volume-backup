# Container engine (docker or podman)
DOCKER := `if command -v podman >/dev/null 2>&1; then echo podman; else echo docker; fi`
COMPOSE := `if command -v podman-compose >/dev/null 2>&1; then echo podman-compose; else echo "{{DOCKER}} compose"; fi`

# Default: Build everything
default: generate build

# Run code generation (including frontend build)
generate:
    go generate ./...

# Build the backrest binary
build:
    go build -o backrest ./cmd/backrest

# Install frontend dependencies
npm-install:
    cd webui && npm install

# Build only the frontend assets
build-frontend:
    cd webui && npm run build

# Start the Docker/Podman Compose environment
up:
    {{COMPOSE}} up -d

# Stop the environment
down:
    {{COMPOSE}} down

# Rebuild and restart containers
rebuild:
    {{COMPOSE}} down
    {{COMPOSE}} up -d --build

# Watch for changes and update the container automatically
watch:
    @if {{COMPOSE}} help watch > /dev/null 2>&1; then \
        {{COMPOSE}} watch; \
    else \
        echo "Native watch not supported by {{DOCKER}}. Using simple polling loop..."; \
        last_sum=""; \
        while true; do \
            new_sum=`find cmd internal pkg proto webui/src -type f -exec md5sum {} + | md5sum`; \
            if [ "$new_sum" != "$last_sum" ]; then \
                if [ "$last_sum" != "" ]; then \
                    echo "Changes detected, rebuilding..."; \
                    {{COMPOSE}} down && {{COMPOSE}} up -d --build; \
                fi; \
                last_sum="$new_sum"; \
            fi; \
            sleep 3; \
        done; \
    fi

# Run all E2E tests
test:
    go test -v ./test/e2e/...

# Clean build artifacts
clean:
    rm -f backrest
    cd webui && npm run clean

# Build everything for Windows
windows: generate-windows build-windows

# Run code generation for Windows assets
generate-windows:
    GOOS=windows go generate ./webui/webuiwin.go

# Build the backrest binary for Windows
build-windows:
    GOOS=windows GOARCH=amd64 go build -o backrest.exe ./cmd/backrest
