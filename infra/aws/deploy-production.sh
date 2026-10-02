#!/usr/bin/env bash
set -euo pipefail

# Creates no customer-visible endpoint until API Gateway HTTPS, VPC-Link-only
# ingress, database encryption, and readiness have all passed. HTTP APIs do
# not provide this app's WebSocket route; mobile must use the supported polling
# fallback for live sync until a dedicated WebSocket edge is separately added.
# The account currently starts with root credentials. The root session only
# creates/updates this named stack; CloudFormation assumes the restricted
# Guardian service role for all stack resource mutations.
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/../.." && pwd)"
region="${AWS_REGION:-ap-south-1}"
stack_name="${GUARDIAN_STACK_NAME:-guardian-production-mvp}"
config_secret_name="${GUARDIAN_CONFIG_SECRET_NAME:-guardian/production/backend-config}"
source_repository="${GUARDIAN_SOURCE_REPOSITORY:-https://github.com/ThisIsDikshithPodhila/YouTube-Gradian_Devin.git}"
source_branch="${GUARDIAN_SOURCE_BRANCH:-$(git -C "$repo_root" branch --show-current)}"
account_id="866490183313"
service_role_arn="arn:aws:iam::${account_id}:role/guardian-mvp-deployer"
config_secret_tmp=""
deployment_parameters_tmp="$(mktemp)"
chmod 0600 "$deployment_parameters_tmp"
trap 'rm -f "$config_secret_tmp" "$deployment_parameters_tmp"' EXIT

if [[ "$region" != "ap-south-1" ]]; then
  echo "Guardian production MVP is pinned to ap-south-1." >&2
  exit 64
fi
export AWS_REGION="$region"
export AWS_DEFAULT_REGION="$region"

for required_command in aws curl git jq python3 timeout; do
  command -v "$required_command" >/dev/null || {
    echo "Missing required command: $required_command" >&2
    exit 69
  }
done

if [[ "$(aws sts get-caller-identity --query Account --output text)" != "$account_id" ]]; then
  echo "Refusing deployment in unexpected AWS account." >&2
  exit 64
fi

remote_sha="$(git ls-remote --heads "$source_repository" "refs/heads/${source_branch}" | awk '{print $1}')"
local_sha="$(git -C "$repo_root" rev-parse HEAD)"
if [[ -z "$remote_sha" || "$remote_sha" != "$local_sha" ]]; then
  echo "Source branch must be pushed at the exact local commit before deployment." >&2
  exit 65
fi

vpc_id="$(aws --region "$region" ec2 describe-vpcs \
  --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text)"
if [[ -z "$vpc_id" || "$vpc_id" == "None" ]]; then
  echo "No default VPC is available; set up a dedicated Guardian VPC before deployment." >&2
  exit 66
fi
vpc_cidr="$(aws --region "$region" ec2 describe-vpcs --vpc-ids "$vpc_id" --query 'Vpcs[0].CidrBlock' --output text)"

mapfile -t public_subnets < <(aws --region "$region" ec2 describe-subnets \
  --filters "Name=vpc-id,Values=${vpc_id}" "Name=map-public-ip-on-launch,Values=true" \
  --query 'sort_by(Subnets,&AvailabilityZone)[].[SubnetId,AvailabilityZone]' --output text)
if (( ${#public_subnets[@]} < 2 )); then
  echo "Expected at least two public subnets in the selected VPC." >&2
  exit 66
fi
read -r public_subnet_id availability_zone_a <<< "${public_subnets[0]}"
read -r _ availability_zone_b <<< "${public_subnets[1]}"
if [[ "$availability_zone_a" == "$availability_zone_b" ]]; then
  echo "Selected subnets are not in distinct Availability Zones." >&2
  exit 66
fi

python3 - "$vpc_cidr" 172.31.48.0/20 172.31.64.0/20 <<'PY'
import ipaddress
import sys

vpc = ipaddress.ip_network(sys.argv[1])
planned = [ipaddress.ip_network(value) for value in sys.argv[2:]]
if planned[0] == planned[1] or planned[0].overlaps(planned[1]):
    raise SystemExit("Guardian private subnet CIDRs must be distinct and non-overlapping.")
if any(not network.subnet_of(vpc) for network in planned):
    raise SystemExit("Guardian private subnet CIDRs must remain inside the selected VPC.")
PY

for cidr in 172.31.48.0/20 172.31.64.0/20; do
  mapfile -t existing_subnet_ids < <(aws --region "$region" ec2 describe-subnets \
    --filters "Name=vpc-id,Values=${vpc_id}" "Name=cidr-block,Values=${cidr}" \
    --query 'Subnets[].SubnetId' --output text)
  for subnet_id in "${existing_subnet_ids[@]}"; do
    [[ -z "$subnet_id" || "$subnet_id" == "None" ]] && continue
    owner_stack="$(aws --region "$region" ec2 describe-tags --filters \
      "Name=resource-id,Values=${subnet_id}" \
      'Name=key,Values=aws:cloudformation:stack-name' \
      --query 'Tags[0].Value' --output text)"
    if [[ "$owner_stack" != "$stack_name" ]]; then
      echo "The planned Guardian private subnet CIDR ${cidr} is already in use by a non-Guardian stack resource." >&2
      exit 66
    fi
  done
done

if ! aws iam get-role --role-name guardian-mvp-deployer >/dev/null 2>&1; then
  echo "Run infra/aws/bootstrap-guardian-deployer.sh once from the account-root session first." >&2
  exit 67
fi

config_secret_arn=""
if config_secret_arn="$(aws --region "$region" secretsmanager describe-secret \
  --secret-id "$config_secret_name" --query ARN --output text 2>/dev/null)"; then
  :
else
  config_secret_tmp="$(mktemp)"
  chmod 0600 "$config_secret_tmp"
  python3 - <<'PY' > "$config_secret_tmp"
import base64
import json
import secrets
from datetime import date

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat, PublicFormat

private_key = Ed25519PrivateKey.generate()
private_seed = private_key.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())
public_key = private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
print(json.dumps({
    "database_password": secrets.token_hex(32),
    "jwt_secret": secrets.token_urlsafe(48),
    "origin_shared_secret": secrets.token_urlsafe(48),
    "policy_key_id": f"guardian-prod-{date.today().isoformat()}",
    "policy_private_key": base64.b64encode(private_seed).decode("ascii"),
    "policy_public_key": base64.b64encode(public_key).decode("ascii"),
}, separators=(",", ":")))
PY
  config_secret_arn="$(aws --region "$region" secretsmanager create-secret \
    --name "$config_secret_name" \
    --description 'Guardian production API signing, database, and private-origin configuration' \
    --secret-string "file://${config_secret_tmp}" \
    --tags Key=Project,Value=guardian Key=Environment,Value=production \
    --query ARN --output text)"
fi

config_json="$(aws --region "$region" secretsmanager get-secret-value --secret-id "$config_secret_arn" \
  --query SecretString --output text)"
database_master_password="$(printf '%s' "$config_json" | jq -r '.database_password')"
origin_shared_secret="$(printf '%s' "$config_json" | jq -r '.origin_shared_secret')"
policy_key_id="$(printf '%s' "$config_json" | jq -r '.policy_key_id')"
policy_public_key="$(printf '%s' "$config_json" | jq -r '.policy_public_key')"
for required_value in "$database_master_password" "$origin_shared_secret" "$policy_key_id" "$policy_public_key"; do
  if [[ -z "$required_value" || "$required_value" == "null" ]]; then
    echo "Guardian backend configuration secret is incomplete." >&2
    exit 68
  fi
done

unset config_json

jq -n \
  --arg vpc_id "$vpc_id" \
  --arg public_subnet_id "$public_subnet_id" \
  --arg availability_zone_a "$availability_zone_a" \
  --arg availability_zone_b "$availability_zone_b" \
  --arg source_repository "$source_repository" \
  --arg source_branch "$source_branch" \
  --arg source_revision "$local_sha" \
  --arg backend_config_secret_arn "$config_secret_arn" \
  --arg database_master_password "$database_master_password" \
  --arg origin_shared_secret "$origin_shared_secret" \
  '[
    {ParameterKey: "VpcId", ParameterValue: $vpc_id},
    {ParameterKey: "PublicSubnetId", ParameterValue: $public_subnet_id},
    {ParameterKey: "AvailabilityZoneA", ParameterValue: $availability_zone_a},
    {ParameterKey: "AvailabilityZoneB", ParameterValue: $availability_zone_b},
    {ParameterKey: "SourceRepository", ParameterValue: $source_repository},
    {ParameterKey: "SourceBranch", ParameterValue: $source_branch},
    {ParameterKey: "SourceRevision", ParameterValue: $source_revision},
    {ParameterKey: "BackendConfigSecretArn", ParameterValue: $backend_config_secret_arn},
    {ParameterKey: "DatabaseMasterPassword", ParameterValue: $database_master_password},
    {ParameterKey: "OriginSharedSecret", ParameterValue: $origin_shared_secret}
  ]' > "$deployment_parameters_tmp"
unset database_master_password origin_shared_secret

aws cloudformation deploy \
  --stack-name "$stack_name" \
  --template-file "${script_dir}/guardian-mvp-stack.yaml" \
  --capabilities CAPABILITY_NAMED_IAM \
  --role-arn "$service_role_arn" \
  --no-fail-on-empty-changeset \
  --parameter-overrides "file://${deployment_parameters_tmp}" \
  --tags Project=guardian Environment=production ManagedBy=cloudformation

stack_output() {
  aws cloudformation describe-stacks --stack-name "$stack_name" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text
}

api_base_url="$(stack_output ApiBaseUrl)"
database_id="$(stack_output DatabaseInstanceIdentifier)"
target_group_arn="$(aws cloudformation describe-stack-resource --stack-name "$stack_name" \
  --logical-resource-id ApiTargetGroup --query 'StackResourceDetail.PhysicalResourceId' --output text)"

for _ in $(seq 1 36); do
  target_health="$(aws elbv2 describe-target-health --target-group-arn "$target_group_arn" \
    --query 'TargetHealthDescriptions[0].TargetHealth.State' --output text)"
  [[ "$target_health" == "healthy" ]] && break
  sleep 10
done
if [[ "${target_health:-}" != "healthy" ]]; then
  echo "API target never became healthy; inspect the Guardian CloudWatch log group before retrying." >&2
  exit 70
fi

database_evidence="$(aws rds describe-db-instances --db-instance-identifier "$database_id" \
  --query 'DBInstances[0].{public:PubliclyAccessible,encrypted:StorageEncrypted,backup_days:BackupRetentionPeriod,engine:Engine,engine_version:EngineVersion}' --output json)"
if ! printf '%s' "$database_evidence" | jq -e \
  '.public == false and .encrypted == true and .backup_days >= 7 and .engine == "postgres"' >/dev/null; then
  echo "Database encryption, privacy, or backup validation failed." >&2
  exit 70
fi

curl --fail --silent --show-error --retry 12 --retry-all-errors --retry-delay 5 "${api_base_url}/livez" >/dev/null
curl --fail --silent --show-error --retry 6 --retry-all-errors --retry-delay 5 "${api_base_url}/readiness" >/dev/null

printf '%s\n' "Guardian API ready: ${api_base_url}"
printf '%s\n' "Policy key id: ${policy_key_id}"
printf '%s\n' "Policy public key: ${policy_public_key}"
printf '%s\n' "Validated: API Gateway TLS, VPC-Link-only ALB ingress, target health, encrypted non-public RDS, and migrations/readiness. WebSocket edge is unavailable; use polling fallback."
