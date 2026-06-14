# Cloudflare Terraform

Beacon uses Terraform for stable Cloudflare control-plane resources and keeps
Wrangler/runtime code responsible for deploys, migrations, and data-plane calls.

## Ownership split

Terraform owns:

- the shared D1 database resource (`scintel`);
- the Cloudflare Queues and dead-letter queues used by the Workers;
- the Pages custom domain (`askbeacon.dev`);
- the One-time PIN identity provider;
- the path-scoped Cloudflare Access applications and allow policies for the
  admin portal.

Wrangler and scripts still own:

- Worker and Pages code deploys;
- D1 schema migrations;
- Worker secrets;
- Pages runtime secret sync;
- D1 queries, Vectorize upserts/deletes, Workers AI calls, and other runtime
  data-plane work.

The Pages project itself is intentionally not Terraform-managed yet. Cloudflare's
provider cannot import a Pages project that already has secret environment
variables, and Beacon currently stores admin/runtime secrets on the Pages
project. Terraform still manages the Pages custom domain and emits the Access
issuer/audience values that the runtime sync step writes into Pages.

## Production environment

Terraform files live in:

```bash
terraform/environments/production
```

Use Terraform CLI `1.5.0` or newer. Copy the example file if running locally:

```bash
cp terraform/environments/production/terraform.tfvars.example \
  terraform/environments/production/terraform.tfvars
```

Set `CLOUDFLARE_API_TOKEN` in the environment. The token needs edit permissions
for D1, Queues, Cloudflare Pages, and Zero Trust Access resources.

Terraform uses the S3-compatible backend so production applies can store state
in Cloudflare R2. Configure these GitHub repository secrets before running the
workflows:

- `TF_STATE_ACCESS_KEY_ID`
- `TF_STATE_SECRET_ACCESS_KEY`

The workflows default to repository variable `TF_STATE_BUCKET` or
`beacon-terraform-state`, and `TF_STATE_KEY` or `cloudflare/production.tfstate`.
Create the R2 bucket and access keys once before the first shared apply.

```bash
cd terraform/environments/production
terraform init \
  -backend-config="bucket=beacon-terraform-state" \
  -backend-config="key=cloudflare/production.tfstate" \
  -backend-config="region=auto" \
  -backend-config="endpoint=https://<account-id>.r2.cloudflarestorage.com" \
  -backend-config="skip_credentials_validation=true" \
  -backend-config="skip_region_validation=true" \
  -backend-config="skip_metadata_api_check=true" \
  -backend-config="force_path_style=true"
terraform plan
terraform apply
```

For a local syntax-only check without remote state:

```bash
terraform init -backend=false
terraform validate
```

## Import existing resources

The current Beacon resources already exist in Cloudflare. Import them before the
first production apply so Terraform does not try to recreate them.

At minimum, import:

```bash
cd terraform/environments/production

terraform import cloudflare_d1_database.scintel '<account-id>/<d1-database-id>'
terraform import cloudflare_pages_domain.site '<account-id>/<pages-project-name>/<hostname>'

terraform import 'cloudflare_queue.beacon["scintel-index-jobs"]' '<account-id>/scintel-index-jobs'
terraform import 'cloudflare_queue.beacon["scintel-index-jobs-dlq"]' '<account-id>/scintel-index-jobs-dlq'
terraform import 'cloudflare_queue.beacon["scintel-answer-jobs"]' '<account-id>/scintel-answer-jobs'
terraform import 'cloudflare_queue.beacon["scintel-answer-jobs-dlq"]' '<account-id>/scintel-answer-jobs-dlq'
terraform import 'cloudflare_queue.beacon["scintel-create-pr-jobs"]' '<account-id>/scintel-create-pr-jobs'
terraform import 'cloudflare_queue.beacon["scintel-create-pr-jobs-dlq"]' '<account-id>/scintel-create-pr-jobs-dlq'
terraform import 'cloudflare_queue.beacon["scintel-triage-jobs"]' '<account-id>/scintel-triage-jobs'
terraform import 'cloudflare_queue.beacon["scintel-triage-jobs-dlq"]' '<account-id>/scintel-triage-jobs-dlq'
```

Also import any existing One-time PIN identity provider and Access applications
that should be preserved. Their IDs are available in the Cloudflare Zero Trust
dashboard or with `cf-terraforming`.

After imports, run:

```bash
terraform plan
```

Treat any proposed replacement of `cloudflare_d1_database.scintel` as a stop
condition. The resource has `prevent_destroy`, but a clean plan is still the
operator signal that ownership has been imported correctly.

The GitHub Actions workflows also fail closed until the manual
`confirm_imported_state` input is checked. They verify the imported state
contains the D1 database, Pages domain, queues, One-time PIN provider, and the
path-scoped Access apps before `terraform apply` runs. This prevents an
accidental first apply from trying to recreate resources that were originally
provisioned outside Terraform.

## Access enable/disable

To protect admin paths:

```bash
terraform apply -var='enable_admin_access=true'
```

To remove the Cloudflare Access edge gate while keeping D1, queues, and the
Pages domain managed:

```bash
terraform apply -var='enable_admin_access=false'
```

The GitHub Actions workflows wrap this:

- `Configure site Access` applies Terraform with `enable_admin_access=true`,
  after `confirm_imported_state` is checked, applies D1 migrations, syncs Pages
  runtime config, and deploys Pages.
- `Make site public` applies Terraform with `enable_admin_access=false`, clears
  Access runtime vars from Pages, and redeploys Pages after the same import
  confirmation.

## Why not Terraform for everything

Per-tenant runtime provisioning is not static infrastructure. The future
database-per-tenant flow should continue using idempotent queue jobs and the
Cloudflare API because tenant signup/deletion is product state, not a human
reviewed infrastructure rollout.

Vectorize is still operated through Wrangler/runtime clients in this repo. Move
the index declaration into Terraform only after the Cloudflare provider supports
the resource and import path cleanly for the account.
