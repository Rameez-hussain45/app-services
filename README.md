# app-services

The application code: five small Node.js services plus the GitHub Actions pipeline.

```
browser -> frontend (8080) -> api-gateway (3000) -> users-service    (3001, PostgreSQL + Redis cache)
                                                 -> orders-service   (3002, PostgreSQL, calls users + payments)
                                                 -> payments-service (3003)
```

| Service | What it does |
|---|---|
| `frontend` | Serves the web page, forwards `/api/*` to the gateway |
| `api-gateway` | Single entry point, routes `/api/users`, `/api/orders`, `/api/payments`, `/api/status` |
| `users-service` | Users CRUD, caches lookups in Redis for 30 s |
| `orders-service` | Creates orders: checks the user, asks payments to charge, saves the result |
| `payments-service` | Pretend payment provider: approves up to 5000, declines above |

Every service exposes `/healthz` and Prometheus metrics on `/metrics`, and writes JSON logs to stdout.

## Run the checks

```bash
npm test                      # needs Node 22, no Docker, no database
```

## Run everything without Kubernetes

```bash
docker compose up --build     # then open http://localhost:8080
```

## CI pipeline (`.github/workflows/ci.yml`)

`test` -> `build` (5 images pushed to Docker Hub) -> `bump-gitops` (writes the new tag into `gitops-config`).
The secrets it needs are listed at the top of the workflow file.
