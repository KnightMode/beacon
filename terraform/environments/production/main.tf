resource "cloudflare_d1_database" "scintel" {
  account_id = var.cloudflare_account_id
  name       = var.d1_database_name

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_queue" "beacon" {
  for_each = local.queue_names

  account_id = var.cloudflare_account_id
  queue_name = each.value
}

resource "cloudflare_pages_domain" "site" {
  account_id   = var.cloudflare_account_id
  project_name = var.pages_project_name
  name         = local.hostname
}

resource "cloudflare_zero_trust_access_identity_provider" "otp" {
  account_id = var.cloudflare_account_id
  name       = "One-time PIN login"
  type       = "onetimepin"
  config     = {}
}

resource "cloudflare_zero_trust_access_application" "admin" {
  for_each = var.enable_admin_access ? local.protected_access_apps : {}

  account_id                 = var.cloudflare_account_id
  name                       = "${var.access_app_name} ${each.value.label}"
  type                       = "self_hosted"
  domain                     = each.value.domain
  session_duration           = var.access_session_duration
  allowed_idps               = [cloudflare_zero_trust_access_identity_provider.otp.id]
  auto_redirect_to_identity  = true
  http_only_cookie_attribute = true
  same_site_cookie_attribute = "strict"

  policies = [{
    name             = var.access_policy_name
    decision         = "allow"
    precedence       = 1
    session_duration = var.access_session_duration
    include          = local.access_include_rules
  }]

  lifecycle {
    precondition {
      condition     = length(local.access_include_rules) > 0
      error_message = "Configure at least one Access allowed email or email domain."
    }
  }
}
