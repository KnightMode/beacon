locals {
  hostname    = lower(trimsuffix(trimprefix(trimprefix(var.pages_custom_domain, "https://"), "http://"), "/"))
  auth_domain = lower(trimsuffix(trimprefix(trimprefix(var.access_auth_domain, "https://"), "http://"), "/"))

  access_allowed_emails = [
    for email in split(",", var.access_allowed_emails_csv) : lower(trimspace(email))
    if trimspace(email) != ""
  ]
  access_allowed_domains = [
    for domain in split(",", var.access_allowed_domains_csv) : lower(trimprefix(trimspace(domain), "@"))
    if trimspace(domain) != ""
  ]
  protected_paths = [
    for path in split(",", var.protected_paths_csv) : substr(trimspace(path), 0, 1) == "/" ? trimspace(path) : "/${trimspace(path)}"
    if trimspace(path) != ""
  ]

  protected_path_labels = {
    "/admin*"                 = "onboarding portal"
    "/api/admin*"             = "admin API"
    "/oauth/slack/callback*"  = "Slack connection"
    "/oauth/github/callback*" = "GitHub connection"
  }

  protected_access_apps = {
    for path in local.protected_paths : path => {
      domain = "${local.hostname}${path}"
      label  = lookup(local.protected_path_labels, path, path)
    }
  }

  access_include_rules = concat(
    [
      for email in local.access_allowed_emails : {
        email = {
          email = email
        }
      }
    ],
    [
      for domain in local.access_allowed_domains : {
        email_domain = {
          domain = domain
        }
      }
    ],
  )

  queue_names = toset([
    "scintel-answer-jobs",
    "scintel-answer-jobs-dlq",
    "scintel-create-pr-jobs",
    "scintel-create-pr-jobs-dlq",
    "scintel-index-jobs",
    "scintel-index-jobs-dlq",
    "scintel-triage-jobs",
    "scintel-triage-jobs-dlq",
  ])
}
