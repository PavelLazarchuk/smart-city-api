# Scheduled jobs

Eight background jobs keep booking data, published content, uploaded files and the operational reports in
shape. They live in [`src/jobs`](../src/jobs) and are the rewrite of the old `services/cron.js`.

## How they run

- **Who schedules.** Only a process started with `JOBS_ENABLED=true` registers cron schedules
  ([`JobsScheduler`](../src/jobs/jobs.scheduler.ts)). API replicas normally run with `JOBS_ENABLED=false`.
- **Who executes.** Every run takes a lease in the `job_locks` collection
  ([`JobLockService`](../src/jobs/job-lock.service.ts)): one atomic upsert per job name, renewed while the job
  works and released afterwards, with `JOB_LOCK_TTL_SECONDS` as the expiry. Several workers may therefore be
  scheduled at once — a tick runs exactly once, and a crashed holder's lease simply expires.
- **Timezone.** Cron expressions are evaluated in `JOBS_TIMEZONE` (e.g. `Europe/Minsk`), not in UTC.
- **Logging.** [`JobRunner`](../src/jobs/job-runner.ts) logs `job started` / `job finished` with the duration
  and the job's own result object, `job skipped: lock held elsewhere` when the lease is taken, and
  `job failed` with the stack. A failing job never crashes the process.
- **Was it healthy?** Every finished run also writes its outcome onto its own lease document —
  `last_started_at`, `last_finished_at`, `last_status`, `last_duration_ms`, `last_success_at`, `last_error`
  and `consecutive_failures`. A run skipped for a held lease writes nothing, because it did not run.
  `GET /api/v1/health/jobs` (super-admin) serves those rows, so "the nightly job has been throwing for a
  week" is a question anyone can answer without a log search. Alert on `job_runs_total{result="failed"}`,
  then read the route for the reason.
- **Writes.** Jobs update slots with targeted `$push` / `$pull` operations and never rewrite the whole
  `options` array, so a booking made while a job runs cannot be overwritten.

## The jobs

| Job                   | Variable                       | Default       | What it does                                         |
| --------------------- | ------------------------------ | ------------- | ---------------------------------------------------- |
| `recurrent_slots`     | `JOB_RECURRENT_SLOTS_CRON`     | `0 3 * * *`   | Generates dated slots from recurrent schedules       |
| `news_expiry`         | `JOB_NEWS_EXPIRY_CRON`         | `0 */2 * * *` | Archives and removes expired news                    |
| `slot_expiry`         | `JOB_SLOT_EXPIRY_CRON`         | `30 3 * * *`  | Archives and removes slots whose date has passed     |
| `stale_bookings`      | `JOB_STALE_BOOKINGS_CRON`      | `0 4 * * *`   | Drops bookings whose slot no longer exists           |
| `cascade_reconcile`   | `JOB_CASCADE_RECONCILE_CRON`   | `30 4 * * *`  | Finishes cascades that never ran, for any parent     |
| `storage_gc`          | `JOB_STORAGE_GC_CRON`          | `0 5 * * *`   | Deletes stored files no `images` row points at       |
| `debtor_report`       | `JOB_DEBTOR_REPORT_CRON`       | `0 12 * * *`  | E-mails the "services without upcoming slots" report |
| `unreferenced_images` | `JOB_UNREFERENCED_IMAGES_CRON` | `30 12 * * *` | E-mails the list of images nothing refers to         |

### `recurrent_slots` — [recurrent-slots.job.ts](../src/jobs/recurrent-slots.job.ts)

For every `service_apply` option that has `recurrent_dates` (a weekday → times schedule), the job projects
those weekdays over the next `RECURRENT_HORIZON_DAYS` days, starting tomorrow, and compares the result with
the option's existing slots. It then applies the difference:

- a date with no slot yet → a new `date_time` slot with the configured times;
- a date whose slot lacks a configured time → that time is appended;
- a time that is no longer configured → removed, **unless it holds bookings**, which are never stranded.

All differences travel as one `bulkWrite`. The job is idempotent: a second run over the same data produces no
changes and reports `services_updated: 0`.

### `news_expiry` — [news-expiry.job.ts](../src/jobs/news-expiry.job.ts)

News items carry an optional `expires_at`. Each expired item is, in its own transaction, deleted from `news`
and written to `archives` as a `news` snapshot. Runs every two hours, so an expired item disappears
promptly rather than at the end of the day. Reports `archived`.

### `slot_expiry` — [slot-expiry.job.ts](../src/jobs/slot-expiry.job.ts)

Scans services that have `date` or `date_time` slots and, per service and inside one transaction:

1. re-reads the service (the scan only produces candidates),
2. writes an `archives` snapshot of every slot whose date is before today, together with the bookings that
   slot held,
3. removes those slots by id,
4. deletes the bookings of those slots.

Reports `services_updated` and `slots_archived`. Archived snapshots expire on their own through the
`archives` TTL index (`ARCHIVE_RETENTION_DAYS`).

### `stale_bookings` — [stale-bookings.job.ts](../src/jobs/stale-bookings.job.ts)

A repair job. With bookings in their own collection there is no second copy to reconcile; what is left is a
booking whose slot was removed by hand or whose service went away outside a cascade. It reads the live slot
coordinates (a projected read — ids and times only), streams the bookings, and deletes in batches those that
point at nothing. Reports `bookings_removed`; in a healthy system it is zero, and a non-zero value is worth
investigating.

### `cascade_reconcile` — [cascade-reconcile.job.ts](../src/jobs/cascade-reconcile.job.ts)

The second repair job, one level up from `stale_bookings`. Deleting an organization runs the hooks in
[`CascadeRegistry`](../src/common/cascade/cascade.registry.ts) inside the same transaction, so the normal
path leaves nothing behind. The abnormal one does: a row removed by a migration, by hand in a shell, or a
restore that brought children back without their parent. `stale_bookings` sees only bookings pointing at a
missing slot; a whole organization gone from under its children is invisible to it.

Detection reads every collection that has an `organization_id` (or, for users, an `organization_ids`), so a
model added later is covered without touching this job; `analytics_events` is the one deliberate exception,
because those rows are a historical record with their own TTL and no hook deletes them. Deletion then goes
through the registered hooks, one transaction per organization — a reconciliation removes exactly what a
real delete would have, in the same order. Anything still pointing at a dangling id afterwards is reported
as `left_behind` and left alone: no hook claims it, and this job does not improvise.

The one way this job could do real damage is by believing an empty or half-restored `organizations`
collection — every child would then look like an orphan, and the hooks would faithfully delete all of them.
Past `JOB_CASCADE_RECONCILE_LIMIT` (default 25) dangling organizations it therefore touches nothing, logs
`cascade reconcile refused`, and returns `refused: true`; a genuine backlog of that size is a deliberate
operation, not a nightly repair.

Reports `dangling_organizations`, `reconciled`, `left_behind` and `refused`; in a healthy system the first
three are empty, and anything else is worth reading the surrounding `orphaned rows found` warning for.

### `storage_gc` — [storage-gc.job.ts](../src/jobs/storage-gc.job.ts)

Deleting an image writes the row first and the file after the commit
([`ImagesService`](../src/modules/images/images.service.ts)) — the right order, because a rolled-back delete
must never lose a file. The cost is that a store which happens to be unreachable at that moment keeps the
file for good: nothing refers to it any more, so nothing will ever retry. Without a sweep the bucket only
grows.

The job streams the store's own listing (`StorageProvider.list()` — a directory walk locally, paged
`ListObjectsV2` on S3), and for each batch of two hundred keys asks `images` which of them still have a row.
Two guards keep a live upload safe: a key is a candidate only once the file is older than
`STORAGE_GC_MIN_AGE` (default `24h`), which covers the window between `put` and the row being written, and
the row lookup happens immediately before the delete rather than from a snapshot taken at the start. A third
guard limits the blast radius: only keys shaped exactly like the ones the upload path writes
(`<organization id>/<uuid><extension>`) are ever deleted, so a bucket shared with backups or static assets
is untouchable by construction. Reports `scanned`, `orphans` and `bytes_freed`.

### `debtor_report` — [debtor-report.job.ts](../src/jobs/debtor-report.job.ts)

Builds the "services without upcoming booking slots" report — an enabled, non-recurrent `service_apply`
option that has no slots at all, or only dated slots that are all in the past — as an `.xlsx` workbook
(`exceljs`) and e-mails it to `REPORT_RECIPIENTS`. With no recipients configured the job still collects the
rows and sends nothing; under `NODE_ENV=production` with `JOBS_ENABLED=true` the environment schema requires
at least one recipient. Reports `rows` and `recipients`.

### `unreferenced_images` — [unreferenced-images.job.ts](../src/jobs/unreferenced-images.job.ts)

The mirror image of `storage_gc`: there the file outlived its row, here the row outlives its use. An admin
uploads a picture, never puts it into the news item, and it stays at full size forever, because nothing in
the product looks at an image it is not rendering.

It only **reports**. An image counts as used when some document repeats its `src` — organization logos,
`news.value.image_value`, `services.value.image_value` — and that judgement is only as complete as the list
in `referencedUrls()`. A field added later and forgotten there would make the job call a live image unused;
deleting on that basis would destroy a published page, while mailing a wrong list costs nothing. Whoever
adds a new field that stores an image URL adds it to that method too. The `.xlsx` goes to
`REPORT_RECIPIENTS`; with nothing to report, or no recipients, it sends no mail. Reports `rows`, `bytes`
and `recipients`.

## Running a job by hand

Jobs are ordinary providers. From a Nest application context:

```ts
const app = await NestFactory.createApplicationContext(AppModule);
await app.get(SlotExpiryJob).run(); // takes the lease, logs, releases
await app.get(SlotExpiryJob).execute(new Date()); // no lease, e.g. for a one-off repair
```

`run()` respects the distributed lock, `execute()` does not — use `execute()` only when you know no worker is
running the same job.

## Tests

[`test/e2e/jobs.e2e-spec.ts`](../test/e2e/jobs.e2e-spec.ts) covers the lease (two workers, one execution;
an expired lease is re-acquirable; a live one is not stealable) and each job's behaviour, including that the
recurrent job preserves existing bookings, that slot expiry archives them before deleting them, that
`storage_gc` spares a fresh file, a referenced file and a key it does not own, and that `cascade_reconcile`
is idempotent. The recorded outcomes and `GET /health/jobs` are covered in
[`test/e2e/observability.e2e-spec.ts`](../test/e2e/observability.e2e-spec.ts).
