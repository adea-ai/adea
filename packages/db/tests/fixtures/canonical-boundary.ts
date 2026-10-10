import postgres from 'postgres'

// The canonical runtime and migration roles, with the attributes infra/postgres/init/001-roles.sql
// gives them. A disposable instance gets the same boundary, so migrations run as the migration role
// and product reads run as the runtime role, never as the instance superuser. Passwords match the
// canonical local values; this instance is ephemeral and never shared.
export const MIGRATION_ROLE = 'agent_hq_local_migration'
export const RUNTIME_ROLE = 'agent_hq_local_app'

const ROLE_ATTRIBUTES = 'nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls'

/** Idempotent: creates the two canonical roles on an instance that does not have them yet. */
export async function ensureCanonicalRoles(admin: postgres.Sql): Promise<void> {
  await admin.begin(async (tx) => {
    // Serializes concurrent suites that provision the same instance.
    await tx.unsafe(`select pg_advisory_xact_lock(hashtext('agent_hq_canonical_roles'))`)
    for (const role of [MIGRATION_ROLE, RUNTIME_ROLE]) {
      await tx.unsafe(`
        do $$ begin
          if not exists (select 1 from pg_roles where rolname = '${role}') then
            create role ${role} login password '${role}' ${ROLE_ATTRIBUTES};
          end if;
        end $$`)
    }
  })
}

/**
 * Creates one owned database for a fixture. The migration role owns it, so migrations create the
 * `app` schema and its tables as that role, and the runtime role receives DML only, through default
 * privileges, the same grants 001-roles.sql gives its `agent_hq` database.
 */
export async function createCanonicalDatabase(
  admin: postgres.Sql,
  urlFor: (database: string) => string,
  database: string
): Promise<void> {
  await ensureCanonicalRoles(admin)
  await admin.unsafe(`create database "${database}" owner ${MIGRATION_ROLE}`)
  const owned = postgres(urlFor(database), { max: 1, onnotice: () => {} })
  try {
    // Mirrors 001-roles.sql: the migration role creates `app` (0000 keeps it IF NOT EXISTS), and the
    // runtime role may use the schema without creating objects in it.
    await owned.unsafe(`create schema app authorization ${MIGRATION_ROLE}`)
    await owned.unsafe(`grant usage on schema app to ${RUNTIME_ROLE}`)
    await owned.unsafe(
      `alter default privileges for role ${MIGRATION_ROLE} grant select, insert, update, delete on tables to ${RUNTIME_ROLE}`
    )
    await owned.unsafe(
      `alter default privileges for role ${MIGRATION_ROLE} grant usage, select, update on sequences to ${RUNTIME_ROLE}`
    )
    for (const role of [MIGRATION_ROLE, RUNTIME_ROLE]) {
      await owned.unsafe(
        `alter role ${role} in database "${database}" set search_path = app, public`
      )
    }
  } finally {
    await owned.end()
  }
}

/** The same instance address as the admin URL, authenticated as one canonical role. */
export function canonicalUrl(adminUrl: string, database: string, role: string): string {
  const url = new URL(adminUrl)
  url.username = role
  url.password = role
  url.pathname = `/${database}`
  return url.toString()
}
