# Portable deployment — clone anywhere and run

Target: a fresh machine (Linux, or Windows with Docker Desktop) with **no
prior setup beyond Docker**. No host DSH installation is required: the agent
runtime is baked into the image.

## 1. Clone

```bash
git clone <your-remote> operant
cd operant
```

The repository is self-contained: 600 KB of source, no vendored dependencies,
no host absolute paths. `node_modules`, `dist/`, `data/` and `secrets/` are
gitignored — everything is rebuilt from `package.json` + `pnpm-lock.yaml`.

## 2. Credentials (the only manual step)

```bash
cp .env.example .env
mkdir -p secrets
```

Two things must be supplied by a human, because they are account credentials:

| What | Where | Why it cannot be generated |
|---|---|---|
| `SURPLUS_API_KEY` (or `ANTSEED_API_KEY`) | `secrets/.credentials.yaml` | It is your model-provider key. The agent route in `services/dsh/profiles/operant/cordis.patch.yml` references it by name (`apiKeyEnv`), so no key ever enters a config file. |
| `OPERANT_BOT_TOKEN` | `.env` | Shared bearer token for the API. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. The API **refuses to start** below 16 characters. |

`secrets/.credentials.yaml` is the DSH credentials file format:

```yaml
version: 1
refs:
  SURPLUS_API_KEY: <your key>
```

It is mounted read-only at `/home/operant/.dsh/.credentials.yaml`. The agent
runtime can read it and cannot rewrite it.

## 3. Run

```bash
docker compose up -d --build          # core: postgres + api + worker
docker compose --profile voice up -d  # + CPU speech service (optional)
docker compose ps
curl -s localhost:8787/v1/health
```

First boot applies `packages/db/migrations/*.sql` in lexical order into an empty
`pgdata` volume and seeds four specialist agents.

## 4. Smoke test

```bash
TOKEN=$(grep ^OPERANT_BOT_TOKEN .env | cut -d= -f2)
curl -s -X POST localhost:8787/v1/requests \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"text":"Reply with exactly HELLO and nothing else.","origin":"api","requestedBy":"smoke"}'
# then poll: curl -s -H "Authorization: Bearer $TOKEN" localhost:8787/v1/tasks?limit=1
```

A correct result is `status: succeeded` with `result: HELLO`. If it stays
`queued`, the worker is not running; if it `failed`, read
`docker compose logs worker`.

## 5. What is deliberately bound to loopback

`8787` (control plane) and `3900` (speech) publish on `127.0.0.1` only. There is
no public listener by design — the MCP transport is unauthenticated, so it must
never be exposed directly to the internet.

To reach the platform from another machine, use an authenticated private
network, not a published port:

```bash
# Tailscale (preferred steady state; needs an account auth key)
tailscale up --authkey=<key>
# or SSH port-forwarding over Google IAP (no inbound port opened)
gcloud compute ssh <instance> --tunnel-through-iap \
  --ssh-flag="-N" --ssh-flag="-L 3900:127.0.0.1:3900"
```

## 6. Moving to new hardware

The whole state is in three Docker volumes: `operant_pgdata`,
`operant_voicestudio_data`, `operant_jobs`. To migrate:

```bash
docker run --rm -v operant_pgdata:/v -v "$PWD":/out alpine \
  tar czf /out/pgdata.tgz -C /v .
```

Then restore the same way on the new host before `docker compose up`. A cold
start with an empty volume is equivalent to a fresh install.

## 7. Known portability caveats

1. The `voicestudio` image is `linux/amd64` only. On an arm64 host (e.g. Apple
   silicon or a Graviton VM) the `voice` profile will not start; the core
   platform still runs.
2. `pnpm` must be `11.19.0` inside the image. Newer corepack-resolved versions
   have shipped without `bin/pnpm.cjs` (observed 12.6.0), which fails the build.
3. `esbuild` and `sharp` postinstall scripts are approved explicitly in
   `pnpm-workspace.yaml` (`allowBuilds`). A host that blocks dependency build
   scripts will fail `pnpm install` with `ERR_PNPM_IGNORED_BUILDS`.
4. Do not name environment variables with a `DSH_` prefix. DSH reserves that
   namespace for its launching environment and refuses to boot if a `.env` in
   the working directory sets one.