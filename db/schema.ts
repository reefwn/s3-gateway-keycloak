import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey(),
    attemptId: uuid("attempt_id"),
    eventKind: text("event_kind").notNull(),
    outcome: text("outcome"),
    errorClass: text("error_class"),
    actorSub: text("actor_sub").notNull(),
    username: text("username"),
    email: text("email"),
    action: text("action").notNull(),
    bucket: text("bucket"),
    objectKey: text("object_key"),
    prefix: text("prefix"),
    details: jsonb("details"),
    correlationId: text("correlation_id").notNull(),
    sourceIp: text("source_ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("audit_events_correlation_id_idx").on(table.correlationId),
    index("audit_events_actor_sub_idx").on(table.actorSub),
    index("audit_events_resource_idx").on(table.bucket, table.objectKey)
  ]
);

export const activeTransfers = pgTable(
  "active_transfers",
  {
    id: uuid("id").primaryKey(),
    actorSub: text("actor_sub").notNull(),
    type: text("type").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("active_transfers_actor_type_expiry_idx").on(table.actorSub, table.type, table.expiresAt)]
);
