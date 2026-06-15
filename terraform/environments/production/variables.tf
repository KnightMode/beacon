variable "cloudflare_account_id" {
  description = "Cloudflare account id that owns the Beacon resources."
  type        = string
}

variable "environment" {
  description = "Human-readable environment label."
  type        = string
  default     = "production"
}

variable "pages_project_name" {
  description = "Existing Cloudflare Pages project name."
  type        = string
  default     = "beacon"
}

variable "pages_custom_domain" {
  description = "Custom hostname attached to the Pages project."
  type        = string
  default     = "askbeacon.dev"
}

variable "d1_database_name" {
  description = "Shared Beacon control-plane D1 database."
  type        = string
  default     = "scintel"
}

variable "enable_admin_access" {
  description = "Create the Access applications that protect admin and OAuth paths."
  type        = bool
  default     = true
}

variable "access_app_name" {
  description = "Prefix for Cloudflare Access application display names."
  type        = string
  default     = "Beacon"
}

variable "access_auth_domain" {
  description = "Cloudflare Access team domain, without protocol."
  type        = string
  default     = "beacon-90k.cloudflareaccess.com"
}

variable "access_policy_name" {
  description = "Name for the admin Access allow policy."
  type        = string
  default     = "Allow approved email OTP"
}

variable "access_session_duration" {
  description = "Cloudflare Access session duration."
  type        = string
  default     = "24h"
}

variable "access_allowed_emails_csv" {
  description = "Comma-separated email addresses allowed through Cloudflare Access."
  type        = string
  default     = "differentialcircuit@gmail.com"
}

variable "access_allowed_domains_csv" {
  description = "Comma-separated email domains allowed through Cloudflare Access."
  type        = string
  default     = ""
}

variable "protected_paths_csv" {
  description = "Comma-separated admin path globs protected by Access."
  type        = string
  default     = "/admin*,/api/admin*,/oauth/slack/callback*,/oauth/github/callback*"
}
