output "d1_database_id" {
  description = "Cloudflare D1 database id for the shared Beacon control plane."
  value       = cloudflare_d1_database.scintel.id
}

output "queue_names" {
  description = "Cloudflare Queue names managed by Terraform."
  value       = sort([for queue in cloudflare_queue.beacon : queue.queue_name])
}

output "pages_custom_domain" {
  description = "Pages custom hostname managed by Terraform."
  value       = cloudflare_pages_domain.site.name
}

output "admin_access_issuer" {
  description = "Issuer used by Pages middleware to verify Cloudflare Access JWTs."
  value       = "https://${local.auth_domain}"
}

output "admin_access_audience_csv" {
  description = "Comma-separated Access audience tags for the admin Pages middleware."
  value       = join(",", [for app in cloudflare_zero_trust_access_application.admin : app.aud])
}

output "admin_access_allowed_emails_csv" {
  description = "Comma-separated Access email allow-list mirrored into Pages runtime config."
  value       = join(",", local.access_allowed_emails)
}

output "admin_access_allowed_domains_csv" {
  description = "Comma-separated Access domain allow-list mirrored into Pages runtime config."
  value       = join(",", local.access_allowed_domains)
}
