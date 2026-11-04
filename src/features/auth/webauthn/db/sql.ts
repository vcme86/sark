/** Shared SQLite/D1 domain operations over Drizzle's synchronous and asynchronous SQLite API. */
import { and, eq } from 'drizzle-orm'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'

import { webauthnCredentials, webauthnSubjects } from '../schema/sqlite'
import type { WebAuthnRecord, WebAuthnStore } from '../store'

export class SqlWebAuthnStore implements WebAuthnStore {
  constructor(
    private readonly db: BaseSQLiteDatabase<'sync' | 'async', unknown>,
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
      .all()
    if (inserted.length) return inserted[0].userHandle
    const [existing] = await this.db
      .select({ userHandle: this.subjects.userHandle })
      .from(this.subjects)
      .where(eq(this.subjects.sub, sub))
      .all()
    if (!existing) throw new Error('WebAuthn subject disappeared during handle creation.')
    return existing.userHandle
  }

  async findCredential(id: string): Promise<WebAuthnRecord | null> {
    const [row] = await this.db
      .select()
      .from(this.credentials)
      .where(eq(this.credentials.credentialId, id))
      .all()
    return row ? this.record(row) : null
  }

  async listCredentials(sub: string): Promise<readonly WebAuthnRecord[]> {
    const rows = await this.db
      .select()
      .from(this.credentials)
      .where(eq(this.credentials.sub, sub))
      .all()
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
      .all()
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
      .all()
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
      .all()
    return rows.length > 0
  }
}
