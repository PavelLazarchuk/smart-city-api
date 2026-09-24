# Load testing

The scenarios live in [load/](../load) and run on [k6](https://k6.io). k6 is a standalone Go binary, not an npm
package. [load/k6.sh](../load/k6.sh) uses a local `k6` when one is installed (`brew install k6`) and otherwise runs
the `grafana/k6` Docker image, so Docker alone is enough.

## The stand

The stand is the production build pointed at a local, throwaway database. The overrides are in
[load/load.env](../load/load.env), loaded with `node --env-file`: a variable set in the shell wins over that file, and
the file wins over `.env`. JWT secrets and the rest still come from `.env`.

| Override                                           | Why                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------- |
| `MONGO_URI` → local `smart-city-load`              | Never load the shared cluster; a shared Atlas tier throttles by itself    |
| `THROTTLE_LIMIT`, `_GLOBAL_LIMIT`, `_UPLOAD_LIMIT` | All traffic comes from one IP, so real limits would only measure 429s     |
| `AUTH_CLIENT_LOGIN_METHOD=password`                | Load users sign in with phone + password; the SMS flow cannot be scripted |
| `JWT_ACCESS_TTL=4h`                                | Tokens are issued once in `setup()` and must outlive a soak run           |
| `LOG_LEVEL=warn`, `JOBS_ENABLED=false`             | Debug logging and cron jobs distort the numbers                           |

`THROTTLE_STORAGE` stays `mongo` because every request pays for a throttler write. Set it to what production runs,
or compare `redis` and `mongo` explicitly.

```bash
docker compose --profile local-db up -d --wait mongo
npm run migrate:load
npm run seed:load          # LOAD_USERS=200 LOAD_SERVICES=50 LOAD_NEWS=30 by default
npm run build
npm run start:load         # separate terminal
npm run load:smoke
```

`seed:load` creates the "Load Test Org" organization with a catalogue, a bookable service with unlimited half-hour
slots 5–7 days ahead, and client accounts `491700000000`… with the password `Load-Test-Pass1`. Running it again keeps
the catalogue and adds any missing users. After those slot dates pass, reset the database:
`docker compose exec mongo mongosh smart-city-load --eval 'db.dropDatabase()'`, then migrate and seed again.

## Scenarios

| Script                                     | What it does                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| [public-read.js](../load/public-read.js)   | Anonymous catalogue: service list, search, detail, nearby, organization, its services, news |
| [availability.js](../load/availability.js) | `GET /services/:id/availability` and `/slots` on the bookable service                       |
| [bookings.js](../load/bookings.js)         | Each VU books a random slot as its own user and cancels it, so capacity never runs out      |
| [auth.js](../load/auth.js)                 | `POST /auth/login` alone: argon2 is expensive on purpose, so keep it out of mixed runs      |
| [mixed.js](../load/mixed.js)               | publicRead 40/s, availability 8/s, bookings 2/s together, the default for `npm run load`    |

Every scenario is an arrival-rate executor: it holds a request rate however slow the API gets, so latency shows up
as latency and not as a quietly lower load.

## Parameters

Pass them with `-e`, after `--` for npm scripts (`npm run load -- -e PROFILE=stress -e RATE=100`).

| Variable      | Default                        | Meaning                                                                    |
| ------------- | ------------------------------ | -------------------------------------------------------------------------- |
| `PROFILE`     | `smoke`                        | `smoke`, `load`, `stress`, `spike`, `soak`                                 |
| `RATE`        | per scenario                   | Iterations per second at the plateau, for every scenario in the run        |
| `RATE_<NAME>` | —                              | One scenario only: `RATE_PUBLICREAD`, `RATE_AVAILABILITY`, `RATE_BOOKINGS` |
| `DURATION`    | `5m` (load), `1h` (soak)       | Plateau length                                                             |
| `BASE_URL`    | `http://localhost:8080/api/v1` | Target API                                                                 |
| `LOAD_USERS`  | `200`                          | Must match the seeded user count                                           |

Profiles: `smoke` is 1 iteration/s for 30 s. `load` ramps to `RATE` over 1 m and holds it. `stress` climbs from
1× to 5× `RATE` in 2.5-minute steps to find the ceiling. `spike` jumps to 10× for a minute. `soak` holds `RATE` for an
hour to surface leaks and connection-pool exhaustion.

A single scenario runs directly: `sh load/k6.sh run -e PROFILE=stress load/availability.js`.

## Reading the results

Thresholds in each script fail the run (exit code 99) when the error rate or p95/p99 crosses the limit, so the
same command works as a CI gate. For the server side, watch `/api/v1/metrics` (per-route latency, event-loop lag),
`docker stats` and `mongostat`/`mongotop` while the run is in progress. `MONGO_MAX_POOL_SIZE=20` is the usual
first bottleneck under write load.
