.PHONY: dev build test lint typecheck audit sbom docker-build clean

dev:
	npm run dev

build:
	npm run build

test:
	npm test

test-watch:
	npm test -- --watch

lint:
	npm run lint

typecheck:
	npx tsc --noEmit

audit:
	npm audit --audit-level=high

sbom:
	npx @cyclonedx/cyclonedx-npm --output-format json --output-file sbom.json
	@echo "SBOM generated: sbom.json"

docker-build:
	docker build -t helix-agent:latest .

docker-up:
	docker-compose up -d

docker-down:
	docker-compose down

clean:
	rm -rf dist node_modules

plugins:
	@echo "Available plugins in ./plugins/:"
	@ls -la ./plugins/ 2>/dev/null || echo "No plugins directory found"

help:
	@echo "Targets: dev build test test-watch lint typecheck audit sbom docker-build docker-up docker-down clean plugins"
