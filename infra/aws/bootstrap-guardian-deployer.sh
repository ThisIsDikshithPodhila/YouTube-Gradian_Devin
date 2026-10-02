#!/usr/bin/env bash
set -euo pipefail

# Bootstrap is the only command that uses the account-root session. It creates
# a Guardian-only CloudFormation service role. The root session can create or
# update this one stack, but CloudFormation performs resource mutations only
# through this narrowly scoped role.
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
account_id="$(aws sts get-caller-identity --query Account --output text)"
expected_account_id="866490183313"
role_name="guardian-mvp-deployer"

if [[ "$account_id" != "$expected_account_id" ]]; then
  echo "Refusing to bootstrap in unexpected AWS account." >&2
  exit 64
fi

if ! aws iam get-role --role-name "$role_name" >/dev/null 2>&1; then
  aws iam create-role \
    --role-name "$role_name" \
    --description "Limited CloudFormation service role for Guardian production MVP" \
    --assume-role-policy-document "file://${script_dir}/guardian-deployer-trust.json" \
    --tags Key=Project,Value=guardian Key=Environment,Value=production >/dev/null
else
  aws iam update-assume-role-policy \
    --role-name "$role_name" \
    --policy-document "file://${script_dir}/guardian-deployer-trust.json"
fi

aws iam put-role-policy \
  --role-name "$role_name" \
  --policy-name guardian-mvp-deployer \
  --policy-document "file://${script_dir}/guardian-deployer-policy.json"

echo "Guardian CloudFormation service role ready: arn:aws:iam::${account_id}:role/${role_name}"
