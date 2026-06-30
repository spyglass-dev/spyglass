# Spyglass — common build targets.

# Build the Studio React app and embed it into spyglass-server (serves at `/`).
.PHONY: ui
ui:
	pnpm install
	pnpm --filter @spyglass/studio build
	cargo build --release --bin spyglass-server --features ui

# Build + serve with the embedded UI (set DATABASE_URL / REPORTING_* first, or
# use `make serve-ui DIR=tests/pagila`).
.PHONY: serve-ui
serve-ui: ui
	./target/release/spyglass-server -C $(or $(DIR),.) serve

# Pure Rust tests (no DB).
.PHONY: test
test:
	cargo test -p spyglass

# Build just the binary (default features — `/` serves the zero-build explorer).
.PHONY: build
build:
	cargo build --bin spyglass-server
