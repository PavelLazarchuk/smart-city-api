# Documentation index

Operational entry point is the [README](../README.md). Everything else:

| Document                           | What it answers                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------ |
| [architecture.md](architecture.md) | How a request flows through the app, what each layer may touch, how modules stay decoupled |
| [auth.md](auth.md)                 | Roles, tokens, sessions, one-time codes, and who may do what                               |
| [errors.md](errors.md)             | The response envelope and every error code with its status                                 |
| [data-model.md](data-model.md)     | Collections, relations, embedded documents, indexes                                        |
| [jobs.md](jobs.md)                 | The eight scheduled jobs, the `job_locks` lease, timezones                                 |
| [migrations.md](migrations.md)     | migrate-mongo workflow, why indexes live in migrations, TTL changes                        |
| [deployment.md](deployment.md)     | Release steps, production-only switches, observability                                     |

The live API contract is the Swagger document generated from the zod schemas: `/api/docs` (UI) and
`/api/docs-json`.
