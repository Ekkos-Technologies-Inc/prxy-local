# prxy-local — convenience targets.
.PHONY: help install build dev test typecheck up down logs migrate clean docker-build

help:
	@echo "prxy-local — make targets"
	@echo ""
	@echo "  make install       Install npm dependencies"
	@echo "  make build         Build to dist/"
	@echo "  make dev           Run the gateway in watch mode"
	@echo "  make test          Run the test suite"
	@echo "  make typecheck     Run TypeScript without emitting"
	@echo "  make up            Start via docker compose"
	@echo "  make down          Stop docker compose"
	@echo "  make logs          Tail docker compose logs"
	@echo "  make migrate       Apply pending SQL migrations"
	@echo "  make docker-build  Build the docker image locally"
	@echo "  make clean         Remove dist + tsbuildinfo"

install:
	npm install

build:
	npm run build

dev:
	npm run dev

test:
	npm test

typecheck:
	npm run typecheck

up:
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f --tail=200

migrate:
	npm run migrate

docker-build:
	docker build -t prxymonster/local:dev .

clean:
	rm -rf dist coverage *.tsbuildinfo
