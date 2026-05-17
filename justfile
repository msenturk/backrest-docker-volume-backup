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

# Start the Docker Compose environment
up:
    docker compose up -d

# Stop the Docker Compose environment
down:
    docker compose down

# Rebuild and restart Docker containers
rebuild:
    docker compose up -d --build

# Run all E2E tests
test:
    go test -v ./test/e2e/...

# Clean build artifacts
clean:
    rm -f backrest
    cd webui && npm run clean

# Run backend in development mode (assumes frontend is built or served separately)
dev-backend:
    go run ./cmd/backrest
