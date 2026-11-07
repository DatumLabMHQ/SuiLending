#!/usr/bin/env bash
# Set this Worker's secrets on Cloudflare. Prompts for each value (input hidden);
# press Enter to skip one. Run after `npx cf auth login`.
set -euo pipefail
WORKER=suilending
for name in DATABASE_URL PLATFORM_READ_URL CRON_SECRET SUI_GRPC_URL SUI_GRPC_BEARER SUI_GRPC_API_KEY BLOCKVISION_API_KEY BEEHIIV_API_KEY BEEHIIV_PUBLICATION_ID SETNEL_HUB_URL SETNEL_SECRET; do
  read -r -s -p "$name: " value; echo
  [ -z "$value" ] && { echo "  skipped"; continue; }
  npx cf workers secrets update "$name" --worker "$WORKER" --type secret_text --text "$value" -q >/dev/null && echo "  set"
done
