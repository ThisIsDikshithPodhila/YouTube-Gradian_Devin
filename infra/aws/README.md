# Guardian AWS consumer-MVP backend

This is an intentionally small, single-region production MVP: API Gateway's
AWS-owned `*.execute-api.<region>.amazonaws.com` HTTPS endpoint is the only
public entry point. API Gateway reaches an internal ALB through a VPC Link;
the ALB accepts only VPC-Link security-group traffic and forwards only requests
whose origin header is overwritten by API Gateway; the API uses encrypted,
non-public PostgreSQL 16 with seven-day automated backups.

It does not modify Devo resources, require a purchased domain, use a public
database, expose SSH, or upload raw child content. API Gateway logs only a
request ID, route key, status, and latency; the API's own request logger
redacts one-time push action tokens.

## One-time bootstrap

Run this only from the AWS account-root session currently used to bootstrap the
account. AWS does not allow that root principal to assume a role, so it creates
or updates a CloudFormation-only `guardian-mvp-deployer` service role. The root
session only submits this named stack and CloudFormation performs stack resource
mutations through the constrained service role. No long-lived IAM user or
access key is created.

```bash
infra/aws/bootstrap-guardian-deployer.sh
```

## Deploy and validate

Push the exact branch first. The deployment script refuses to use an unpushed
or divergent branch, then passes that immutable Git commit SHA into the worker
build. It creates the Secrets Manager configuration only when it is absent,
provisions the stack, and then validates the public HTTPS endpoint,
readiness/migrations, ALB target health, and RDS privacy / encryption / backup
settings.

Each source-revision update also replaces the single API instance through a
revision-scoped, no-ingress security-group reference. This deliberately
re-runs the immutable boot script; changing EC2 user data alone only restarts
an EBS-backed instance and does not replay the script.

The VPC Link security group is the sole source allowed to reach the internal
ALB. Its integration overwrites the origin header, which keeps direct internal
ALB requests on a 403 default action.

```bash
GUARDIAN_SOURCE_BRANCH=codex/aws-mvp-deploy infra/aws/deploy-production.sh
```

The final three output lines provide the AWS HTTPS base URL and the public
Ed25519 key/id that must be embedded in the Android release build. The private
seed, JWT secret, database password, origin header secret, and STS credentials
are never printed or committed.

## Cost and availability boundary

The stack uses one `t3.small` EC2 instance, one internal ALB, one HTTP API plus
VPC Link, one single-AZ `db.t4g.micro` RDS instance with 20 GiB gp3 storage,
CloudWatch logs (30 days), and Secrets Manager. This is a low-cost production
MVP, not an HA deployment: an AZ or EC2 failure interrupts service until
recovered. RDS has seven-day backups; a restore drill and multi-AZ RDS are the
next reliability upgrade.

HTTP API private integrations do not provide this application's WebSocket
route. The Android app must use its existing polling fallback (target two
seconds) until a dedicated WebSocket-capable edge is validated. Do not claim
WSS coverage from this deployment.

Two CloudWatch alarms are created without actions because no approved alarm
recipient was discoverable. Add an SNS recipient and a Guardian-specific AWS
Budget before customer rollout.
