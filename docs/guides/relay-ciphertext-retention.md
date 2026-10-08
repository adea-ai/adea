# Expired relay ciphertext cleanup

This operator removes expired initial Task command envelopes from the current
cloud relay rows. It preserves intent identity/hash, selected host/profile,
outbox delivery status and attempts, Task/execution state, keys, events and
Message/ContentReplica history. It never acknowledges delivery or cancels work.

## Prerequisites and rollout

1. Use an approved isolated or production target. Exploratory checks use an
   owned disposable database, never a shared development or production target.
2. Apply and verify additive migration 0039 through the approved migration
   process before deploying application code that reads `ciphertext_purged_at`.
   Confirm the column, partial `task_submissions_ciphertext_expiry_idx` and
   `task_submissions_purge_after_expiry` constraint exist. The current main-push
   migration and Worker workflows run independently; merging both changes does
   not prove deployment order or successful production migration.
3. Supply `DATABASE_URL_UNPOOLED` securely in the server/operator environment.
   It must use the intended `_app` role, direct host, port and database.
   Hosted targets require TLS (`sslmode=require`, `verify-ca` or `verify-full`);
   Neon pooler hosts are refused. Migration-role credentials are not accepted.
   Only `sslmode` is allowed as a URL query parameter; endpoint overrides are
   refused. Keep credentials out of argv, shell history and published logs.
4. Choose one actual workspace UUID and a batch limit from 1 to 1,000. There
   is no global/wildcard workspace default and no caller-supplied expiry clock.

## Preview and apply

Replace the example target and workspace with the exact intended values:

```sh
bun run relay:purge --host db.example.invalid --port 5432 --database adea \
  --workspace 550e8400-e29b-41d4-a716-446655440000 --limit 100
```

This defaults to read-only preview. After checking that target and result, use
the same arguments with `--apply` to perform one bounded transaction:

```sh
bun run relay:purge --host db.example.invalid --port 5432 --database adea \
  --workspace 550e8400-e29b-41d4-a716-446655440000 --limit 100 --apply
```

The entry builds the public type dependency for a fresh checkout. Its final
stdout record has `schemaVersion`, `mode` (`dry_run` or `apply`), `count` and
`limit`. Preview counts at most `limit` eligible expired, unmarked intents;
apply reports processed intents, including already-absent envelopes. Neither
record contains ciphertext, credentials, native metadata or raw driver errors.

Invalid arguments, unavailable/unsafe database configuration and mismatched
target are refused before creating a connection. Other database/cleanup errors
return only `retention_unavailable`, with a nonzero exit code. A failed command
does not establish successful cleanup; investigate through authorized private
database diagnostics, then re-run the same bounded operation. The command
closes its connection before reporting success.

## Scheduling and verification

An operator or separately authorized scheduler invokes this supported entry for
explicit workspaces. No timer, cron binding, production activation or scheduler
credential is installed by this implementation. A scheduler must keep target
and workspace scope explicit, bound each batch/run, retain sanitized outcomes,
and retry skipped locked rows instead of treating zero as proof of no backlog.

Database time establishes expiry. Active envelopes are retained. Concurrent
workers skip row locks; an outer rollback restores envelope and marker together.
Inspect retained intent/hash/status and expired summary independently of command
bytes. A fresh signed node pull must not redeliver an expired command. Task
cancellation, execution reconciliation, host inbox replay and host private-key
retention remain separate operations.

Removing the current JSONB envelope is not secure erasure from WAL, backups or
replicas. Their authorized retention/restore policies must be verified
separately. Restore replay can make a row eligible again; unchanged identity
and idempotent cleanup must remain intact. Do not delete the linked outbox or
submission to reclaim content, and do not sweep canonical history.

Rollback is forward-only. Keep the additive column/index/constraint during an
application rollback; stopped cleanup may retain ciphertext longer but must not
fabricate a new submission or revive an expired envelope. Resume via bounded
preview/apply after the supported code/schema and operational target are verified.
