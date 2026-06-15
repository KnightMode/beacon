terraform {
  required_version = ">= 1.5.0"

  backend "s3" {}

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.15"
    }
  }
}

provider "cloudflare" {}
