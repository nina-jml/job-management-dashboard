COMPOSE := docker compose
# `make up` overlays host ports; `make test` deliberately does not, so the gate
# cannot fail on a port that is already in use elsewhere.
COMPOSE_DEV := docker compose -f docker-compose.yml -f docker-compose.dev.yml
APP_SERVICES := db backend frontend

POSTGRES_HOST_PORT ?= 55432

# Baseline data for the E2E run. Fixed seed so the suite is deterministic;
# --clear so a re-run starts from the same state (TEST_PLAN case F3).
SEED_COUNT ?= 30
SEED_ARGS  ?= --count $(SEED_COUNT) --clear --seed 42

.DEFAULT_GOAL := help
.PHONY: help build up stop down clean test test-spec test-backend test-all seed logs ps shell db-url psql time

help: ## Show available commands
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

build: ## Build all Docker images
	$(COMPOSE) build

up: ## Start the stack and wait until it is healthy (app on http://localhost:8080)
	$(COMPOSE_DEV) up -d --build --wait $(APP_SERVICES)
	@echo ""
	@echo "  ▸ app  http://localhost:8080"
	@echo "  ▸ api  http://localhost:8000/api/health/"
	@$(MAKE) --no-print-directory db-url

test: ## Run the Playwright E2E suite (builds and starts the stack first)
	$(COMPOSE) up -d --build --wait $(APP_SERVICES)
	@echo "▸ seeding baseline test data ($(SEED_COUNT) jobs; existing jobs are cleared)"
	$(COMPOSE) exec -T backend python manage.py seed_jobs $(SEED_ARGS)
	$(COMPOSE) run --rm --build e2e

test-spec: ## Run one spec against the running stack, e.g. make test-spec SPEC=01-jobs-list-api
	@test -n "$(SPEC)" || { echo "usage: make test-spec SPEC=<spec-name>"; exit 2; }
	# Uses the dev overlay so running a spec does not reconcile the stack back to
	# the base config and drop the host ports `make up` published. `make test`
	# uses the base config on purpose and will drop them — run `make up` after.
	$(COMPOSE_DEV) run --rm e2e npx playwright test $(SPEC)

test-backend: ## Run backend unit tests (pytest-django), outside the make test gate
	$(COMPOSE) up -d --wait db
	# --build so the image carries the code being tested. Backend source is not
	# bind-mounted (unlike e2e specs) — the image stays the artifact.
	$(COMPOSE) run --rm --build backend pytest

test-all: test-backend test ## Run backend unit tests and the E2E suite

seed: ## Seed N jobs, e.g. make seed N=250000
	$(COMPOSE) exec -T backend python manage.py seed_jobs --count $(or $(N),50)

stop: ## Stop the running containers
	$(COMPOSE) stop

down: ## Stop and remove containers and networks (keeps the database volume)
	$(COMPOSE) down --remove-orphans

clean: ## Remove containers, networks, volumes and locally built images
	# On Linux the e2e service runs as root, so its bind-mounted playwright-report/
	# and test-results/ land in the working tree root-owned; a host-side rm then
	# hits "Permission denied". Deleting them from inside a container matches the
	# privileges that created them. See docs/OPEN_QUESTIONS.md §3.
	docker run --rm -v "$(CURDIR)/e2e:/work" alpine sh -c 'rm -rf /work/playwright-report /work/test-results'
	$(COMPOSE) down --volumes --remove-orphans --rmi local
	@echo "▸ clean slate"

clean-all: clean ## Also drop pulled base images and the build cache — a genuinely cold start
	# `make clean` uses --rmi local, which removes the images this project built
	# but keeps the base images it pulled *and* the BuildKit cache. That is the
	# right default for day-to-day work and the wrong one for verifying the
	# evaluator's experience: a rebuild after `clean` still serves the expensive
	# `playwright install --with-deps chromium` layer from cache, so it finishes
	# in a fraction of the time a first-time build takes.
	#
	# This is the T3 command. It leaves nothing behind, so `make build` has to
	# pull and compile everything exactly as it would on a machine that has
	# never seen this project.
	-docker image rm -f \
		$$(awk '/^FROM /{print $$2} /^ *image: /{print $$2}' \
			frontend/Dockerfile backend/Dockerfile e2e/Dockerfile docker-compose.yml \
			| sort -u) 2>/dev/null
	docker builder prune --all --force
	@echo "▸ cold slate — base images and build cache gone"

db-url: ## Print the Postgres connection string for a GUI client
	@echo "  ▸ db   postgresql://$${POSTGRES_USER:-jobs}:$${POSTGRES_PASSWORD:-jobs}@127.0.0.1:$(POSTGRES_HOST_PORT)/$${POSTGRES_DB:-jobs}"

psql: ## Open a psql shell against the running database
	$(COMPOSE) exec db psql -U $${POSTGRES_USER:-jobs} -d $${POSTGRES_DB:-jobs}

logs: ## Tail logs from all services
	$(COMPOSE) logs -f

ps: ## Show service status
	$(COMPOSE) ps

shell: ## Open a Django shell
	$(COMPOSE) exec backend python manage.py shell

time: ## Render and print the project time log
	@./scripts/timelog.sh report
