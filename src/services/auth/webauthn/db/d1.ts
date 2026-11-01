/** Cloudflare D1 authentication persistence; the application owns the borrowed database. */
import { and, eq } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'

import {
  assertDatabaseDriver,
  type CompatibleTable,
  getDatabase,
  resolveTable,
} from '../../database'
import type { StoreContext, StoreDeclaration } from '../../store'
import { webauthnCredentials, webauthnSubjects } from '../schema/sqlite'
import type { SqlWebAuthnOptions, WebAuthnRecord, WebAuthnStore } from '../store'

export class D1WebAuthnStore implements WebAuthnStore {
  constructor(
    private readonly db: DrizzleD1Database,
    private readonly subjects = webauthnSubjects,
    private readonly credentials = webauthnCredentials,
  ) {}

  private record(row: typeof webauthnCredentials.$inferSelect): WebAuthnRecord {
    return {
      credentialId: row.credentialId,
      sub: row.sub,
      userHandle: row.userHandle,
      publicKey: new Uint8Array(row.publicKey),
      counter: row.counter,
      transports: row.transports ? JSON.parse(row.transports) : undefined,
      deviceType: row.deviceType ?? undefined,
      backedUp: row.backedUp,
      revision: row.revision,
      createdAt: row.createdAt,
    }
  }

  async getOrCreateUserHandle(sub: string): Promise<string> {
    const inserted = await this.db
      .insert(this.subjects)
      .values({ sub, userHandle: crypto.randomUUID() })
      .onConflictDoNothing({ target: this.subjects.sub })
      .returning({ userHandle: this.subjects.userHandle })
    if (inserted.length) return inserted[0].userHandle
    const [existing] = await this.db
      .select({ userHandle: this.subjects.userHandle })
      .from(this.subjects)
      .where(eq(this.subjects.sub, sub))
    if (!existing) throw new Error('WebAuthn subject disappeared during handle creation.')
    return existing.userHandle
  }

  async findCredential(id: string): Promise<WebAuthnRecord | null> {
    const [row] = await this.db
      .select()
      .from(this.credentials)
      .where(eq(this.credentials.credentialId, id))
    return row ? this.record(row) : null
  }

  async listCredentials(sub: string): Promise<readonly WebAuthnRecord[]> {
    const rows = await this.db.select().from(this.credentials).where(eq(this.credentials.sub, sub))
    return rows.map((row) => this.record(row))
  }

  async insertCredential(record: WebAuthnRecord): Promise<boolean> {
    const rows = await this.db
      .insert(this.credentials)
      .values({
        ...record,
        publicKey: Buffer.from(record.publicKey),
        transports: record.transports ? JSON.stringify(record.transports) : null,
        deviceType: record.deviceType ?? null,
        backedUp: record.backedUp ?? false,
      })
      .onConflictDoNothing({ target: this.credentials.credentialId })
      .returning({ id: this.credentials.credentialId })
    return rows.length > 0
  }

  async updateCredential(
    id: string,
    sub: string,
    revision: string,
    record: WebAuthnRecord,
  ): Promise<boolean> {
    const rows = await this.db
      .update(this.credentials)
      .set({
        counter: record.counter,
        backedUp: record.backedUp ?? false,
        deviceType: record.deviceType ?? null,
        revision: record.revision,
      })
      .where(
        and(
          eq(this.credentials.credentialId, id),
          eq(this.credentials.sub, sub),
          eq(this.credentials.revision, revision),
        ),
      )
      .returning({ id: this.credentials.credentialId })
    return rows.length > 0
  }

  async removeCredential(id: string, sub: string, revision: string): Promise<boolean> {
    const rows = await this.db
      .delete(this.credentials)
      .where(
        and(
          eq(this.credentials.credentialId, id),
          eq(this.credentials.sub, sub),
          eq(this.credentials.revision, revision),
        ),
      )
      .returning({ id: this.credentials.credentialId })
    return rows.length > 0
  }
}

/**
 * Declares persistence using a database owned by the application.
 * @param options - Database declaration and optional compatible table mappings.
 * @returns A store declaration initialized after application resources are ready.
 * @throws If the database driver or mapped columns are incompatible.
 */
export function sqlWebAuthn(
  options: SqlWebAuthnOptions<
    CompatibleTable<typeof webauthnSubjects>,
    CompatibleTable<typeof webauthnCredentials>
  >,
): StoreDeclaration<WebAuthnStore> {
  assertDatabaseDriver(options.database, 'd1')
  const subjects = resolveTable(options.tables?.subjects, webauthnSubjects)
  const credentials = resolveTable(options.tables?.credentials, webauthnCredentials)
  return {
    target: 'cloudflare',
    create(context: StoreContext) {
      return {
        value: new D1WebAuthnStore(
          getDatabase<DrizzleD1Database>(options.database, context),
          subjects,
          credentials,
        ),
      }
    },
  }
}
