-- Migration 0009: map Cloudflare Access admin emails to tenants so the portal
-- can restore the workspace session after Access sign-in without forcing the
-- admin to redo the Slack OAuth connect flow.

CREATE TABLE IF NOT EXISTS tenant_admin_emails (
  email       TEXT NOT NULL,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (email, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_admin_emails_tenant ON tenant_admin_emails (tenant_id);
