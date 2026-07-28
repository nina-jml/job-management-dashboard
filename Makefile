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

# The e2e container runs as root, so on Linux the report it writes to the bind
# mount is root-owned (bind mounts pass the UID through untranslated). chown it
# back to the invoking user from inside a container — no sudo, no-op on macOS,
# never fails the caller. `make test` and `make test-spec` run this after the
# suite, preserving the suite's exit code so a red run still fails.
E2E_CHOWN = docker run --rm -v "$(CURDIR)/e2e:/work" alpine chown -R "$$(id -u):$$(id -g)" /work/playwright-report /work/test-results >/dev/null 2>&1 || true

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
	# Run the suite, hand its report back to you (see E2E_CHOWN), then exit with the
	# suite's own status so a red run still fails the gate.
	@rc=0; $(COMPOSE) run --rm --build e2e || rc=$$?; \
		$(E2E_CHOWN); \
		exit $$rc

test-spec: ## Run one spec against the running stack, e.g. make test-spec SPEC=01-jobs-list-api
	@test -n "$(SPEC)" || { echo "usage: make test-spec SPEC=<spec-name>"; exit 2; }
	# Uses the dev overlay so running a spec does not reconcile the stack back to
	# the base config and drop the host ports `make up` published. `make test`
	# uses the base config on purpose and will drop them — run `make up` after.
	# Same chown-back as `make test` (see E2E_CHOWN), exit code preserved.
	@rc=0; $(COMPOSE_DEV) run --rm e2e npx playwright test $(SPEC) || rc=$$?; \
		$(E2E_CHOWN); \
		exit $$rc

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
	# `make test` and `make test-spec` chown their e2e output back to you, but a run
	# interrupted before that (Ctrl-C) can still leave playwright-report/ and
	# test-results/ root-owned on Linux, where a host-side rm would hit "Permission
	# denied". Delete them from inside a container, matching the privileges that
	# created them. See docs/OPEN_QUESTIONS.md §3.
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
