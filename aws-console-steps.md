# Spice Route Kitchen — Full AWS Console Deployment Steps

Classic 3-tier architecture: VPC → Application Load Balancer → EC2 Auto
Scaling Group → RDS PostgreSQL. Built via the AWS Console (no CLI/IaC), in
the **us-east-2 (Ohio)** region, matching your other projects.

**Chosen trade-offs (confirm these match what you want before starting):**
- **No NAT Gateway** — private subnets have no internet route at all. The app
  tier only needs RDS (same VPC, no internet needed) and one SSM interface
  VPC endpoint (for fetching its DB password). This is the main ongoing-cost
  saver vs. a "textbook" 3-tier build.
- **Single-AZ RDS** — keeps cost down for a portfolio project. Multi-AZ is a
  one-click upgrade later and worth mentioning in an interview as the
  production-hardening step you'd take next.
- **No custom domain** — you'll access the site via the ALB's own DNS name,
  same approach as the guestbook project. Nothing stops you adding Route 53
  + ACM later the same way you did for Companion.

---

## Architecture

![Architecture diagram](docs/architecture-diagram.svg)

```
Diner's browser
      |
      v
Application Load Balancer  (public subnets, 2 AZs)
      |
      v
EC2 Auto Scaling Group — Node/Express app  (private "app" subnets, 2 AZs)
      |                                  \
      v                                   v (HTTPS :443, via SSM interface endpoint)
RDS PostgreSQL  (private "db" subnets)     AWS Systems Manager Parameter Store
                                            (DB password, SecureString)
```

CIDR plan (VPC `10.0.0.0/16`):

| Subnet | CIDR | AZ | Purpose |
|---|---|---|---|
| Public A | `10.0.0.0/24` | us-east-2a | ALB |
| Public B | `10.0.1.0/24` | us-east-2b | ALB |
| Private App A | `10.0.10.0/24` | us-east-2a | EC2 ASG |
| Private App B | `10.0.11.0/24` | us-east-2b | EC2 ASG |
| Private DB A | `10.0.20.0/24` | us-east-2a | RDS |
| Private DB B | `10.0.21.0/24` | us-east-2b | RDS |

Files for this project (sent separately): `app/` (server.js, public/, db/schema.sql, package.json).

---

## Phase 1 — VPC, subnets, and routing

1. Go to **VPC → Your VPCs → Create VPC**.
2. Choose **VPC and more** (the wizard) — this creates subnets, route tables, and an internet gateway in one go.
   - **Name tag**: `spiceroute-vpc`
   - **IPv4 CIDR**: `10.0.0.0/16`
   - **Number of Availability Zones**: 2
   - **Number of public subnets**: 2
   - **Number of private subnets**: 4 *(the wizard only supports one private "tier" by default — we'll relabel two of these as the DB tier and fix their CIDRs after creation; see step 3)*
   - **NAT gateways**: **None** (this is the cost-saving choice from above)
   - **VPC endpoints**: **None** for now — we'll add the SSM interface endpoint by hand in Phase 4 so it lands in the right subnets/SG.
   - Click **Create VPC**.
3. Once created, go to **Subnets** and adjust the 4 private subnets the wizard made so they match the CIDR plan above:
   - Rename two of them to `spiceroute-private-app-A` / `spiceroute-private-app-B` (keep their auto-assigned CIDRs, e.g. `10.0.128.0/24` / `10.0.144.0/24` — the exact numbers the wizard picked don't matter, only that A and B are in different AZs).
   - Rename the other two to `spiceroute-private-db-A` / `spiceroute-private-db-B`.
   - Rename the two public subnets to `spiceroute-public-A` / `spiceroute-public-B`.
   - *(The CIDR table above is the "ideal" reference plan — the wizard's auto-picked ranges work exactly the same functionally. Don't hand-edit CIDRs; it's not worth the risk of breaking a subnet.)*
4. Confirm route tables: **Subnets → select each private subnet → Route table tab** — should show only a `local` route (10.0.0.0/16) and no `0.0.0.0/0` route. Public subnets should show a `0.0.0.0/0` route pointing at the Internet Gateway.

---

## Phase 2 — Security groups

Go to **EC2 → Security Groups → Create security group**, create these four (all in `spiceroute-vpc`):

1. **`spiceroute-alb-sg`**
   - Inbound: HTTP 80 from `0.0.0.0/0`.
   - Outbound: leave default (all traffic).
2. **`spiceroute-app-sg`**
   - Inbound: Custom TCP 3000 from source = `spiceroute-alb-sg` (select the security group, not an IP range).
   - Outbound: leave default (all traffic) — this is fine even with no NAT, since the private subnet's route table simply has nowhere to send internet-bound packets.
3. **`spiceroute-db-sg`**
   - Inbound: PostgreSQL 5432 from source = `spiceroute-app-sg`.
   - Also add: PostgreSQL 5432 from source = `spiceroute-builder-sg` (create that group next, then come back and add this rule).
   - Outbound: default.
4. **`spiceroute-builder-sg`** (for the temporary setup instance in Phase 5)
   - Inbound: SSH 22 from source = **My IP**.
   - Outbound: default.
5. **`spiceroute-vpce-sg`** (for the SSM VPC endpoint in Phase 4)
   - Inbound: HTTPS 443 from source = `spiceroute-app-sg`.
   - Outbound: default.

(Go back to `spiceroute-db-sg` now and add the `spiceroute-builder-sg` inbound rule mentioned above.)

---

## Phase 3 — RDS PostgreSQL

1. Go to **RDS → Subnet groups → Create DB subnet group**.
   - Name: `spiceroute-db-subnet-group`, VPC: `spiceroute-vpc`.
   - Add subnets: `spiceroute-private-db-A` and `spiceroute-private-db-B`.
2. Go to **RDS → Databases → Create database**.
   - **Engine**: PostgreSQL (latest available default version).
   - **Templates**: Free tier (if available on your account) or Dev/Test.
   - **DB instance identifier**: `spiceroute-db`.
   - **Credentials management**: **Self managed** is fine too, but choose **Manage master credentials in AWS Secrets Manager** if offered — it auto-generates a strong master password and stores it for you, so you never type or copy one around.
   - **Master username**: `spiceroute_admin`.
   - **Instance class**: `db.t3.micro`.
   - **Storage**: 20 GB, gp3, disable storage autoscaling (keeps cost predictable).
   - **Multi-AZ**: **No** (single-AZ, per the cost trade-off above).
   - **Connectivity → VPC**: `spiceroute-vpc`. **Subnet group**: `spiceroute-db-subnet-group`. **Public access**: **No**. **VPC security group**: choose existing → `spiceroute-db-sg` (remove the default one).
   - **Additional configuration → Initial database name**: `spice_route_kitchen`.
   - Create the database. Takes several minutes.
3. Once available, open the DB instance and copy its **Endpoint** (looks like `spiceroute-db.xxxxxxxxxx.us-east-2.rds.amazonaws.com`) — you'll need it shortly.
4. If you used the Secrets Manager option: **RDS → Databases → spiceroute-db → Configuration** — find the **Master credentials ARN**, click through to Secrets Manager, and **Retrieve secret value** to see the auto-generated master password. Keep this tab open; you'll use it once in Phase 6.

---

## Phase 4 — SSM interface VPC endpoint

This is what lets the private app tier call `ssm:GetParameter` (to fetch its DB password) with no internet route at all.

1. Go to **VPC → Endpoints → Create endpoint**.
2. **Name tag**: `spiceroute-ssm-endpoint`.
3. **Service category**: AWS services. **Service name**: search for and select `com.amazonaws.us-east-2.ssm`.
4. **VPC**: `spiceroute-vpc`.
5. **Subnets**: select both `spiceroute-private-app-A` and `spiceroute-private-app-B`.
6. **Security group**: `spiceroute-vpce-sg` only (uncheck default).
7. **Policy**: Full access is fine for a portfolio project.
8. Create endpoint. Wait for **Status: Available**.

---

## Phase 5 — Launch a temporary "builder" EC2 instance

This instance does two jobs: (1) set up the database schema and a
least-privilege app database user, (2) become the base for a custom "golden"
AMI with Node.js and the app pre-installed. It lives in a **public** subnet
so it has internet access; you'll terminate it once the AMI is built.

1. First, create an S3 bucket to stage the app code: **S3 → Create bucket** → name it something like `spiceroute-app-build-<random-suffix>`, same region, **Block Public Access fully on**. Upload the `app/` folder as a zip (`app.zip`) to this bucket.
2. **EC2 → Instances → Launch instance**.
   - **Name**: `spiceroute-builder`.
   - **AMI**: Amazon Linux 2023.
   - **Instance type**: `t3.micro`.
   - **Key pair**: create or select one (needed as a fallback; you'll mainly connect via EC2 Instance Connect).
   - **Network settings**: VPC `spiceroute-vpc`, subnet `spiceroute-public-A`, **Auto-assign public IP: Enable**, security group: select existing → `spiceroute-builder-sg`.
   - **IAM instance profile**: click **Create new IAM profile**, name it `spiceroute-builder-role`, attach a policy scoped to just this bucket:
     ```json
     {
       "Version": "2012-10-17",
       "Statement": [
         {
           "Effect": "Allow",
           "Action": ["s3:GetObject"],
           "Resource": "arn:aws:s3:::spiceroute-app-build-<random-suffix>/*"
         }
       ]
     }
     ```
     Refresh the IAM profile dropdown back on the launch page and select it.
   - Launch the instance.
3. Once running, select it → **Connect → EC2 Instance Connect → Connect** (browser-based shell, no key pair needed).

---

## Phase 6 — Set up the database

From the `spiceroute-builder` shell:

```bash
sudo dnf install -y postgresql15
```

Connect as the master user (use the endpoint from Phase 3 and the password from the Secrets Manager tab you kept open):

```bash
psql -h <your-rds-endpoint> -U spiceroute_admin -d spice_route_kitchen
```

At the `psql` prompt, paste the contents of `db/schema.sql` (creates the `reservations` table), then create a dedicated, least-privilege application user — **don't reuse `spiceroute_admin` in the app**:

```sql
CREATE USER spiceroute_app WITH PASSWORD 'choose-a-strong-password-here';
GRANT CONNECT ON DATABASE spice_route_kitchen TO spiceroute_app;
GRANT SELECT, INSERT ON reservations TO spiceroute_app;
GRANT USAGE, SELECT ON SEQUENCE reservations_id_seq TO spiceroute_app;
\q
```

Now store that password where the app can find it — **using your own console
session**, not the builder instance, since this only needs your IAM user's
permissions, not the EC2 role's:

1. Go to **Systems Manager → Parameter Store → Create parameter**.
2. **Name**: `/spice-route-kitchen/db/password`.
3. **Type**: **SecureString** (leave the default `alias/aws/ssm` KMS key).
4. **Value**: the same password you set for `spiceroute_app` above.
5. Create parameter.

---

## Phase 7 — Build the golden AMI

Still in the `spiceroute-builder` shell:

```bash
# Node.js 20
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo dnf install -y nodejs unzip

# Pull the app code you staged in S3
aws s3 cp s3://spiceroute-app-build-<random-suffix>/app.zip /home/ec2-user/app.zip
cd /home/ec2-user && unzip app.zip -d app && cd app
npm install --production

# Quick sanity check (uses the RDS endpoint + app password directly, just to confirm it works)
DB_HOST=<your-rds-endpoint> DB_NAME=spice_route_kitchen DB_USER=spiceroute_app \
  DB_PASSWORD='<the password you set>' PORT=3000 node server.js &
sleep 2 && curl -s localhost:3000/health && echo " <- should print: ok"
kill %1
```

Set it up as a systemd service so it starts automatically on every boot,
reading its config from an environment file that user data will write:

```bash
sudo tee /etc/systemd/system/spiceroute-app.service > /dev/null <<'EOF'
[Unit]
Description=Spice Route Kitchen app
After=network.target

[Service]
Type=simple
EnvironmentFile=/etc/spiceroute-app.env
ExecStart=/usr/bin/node /home/ec2-user/app/server.js
Restart=always
User=ec2-user
WorkingDirectory=/home/ec2-user/app

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable spiceroute-app
```

Don't start it yet — there's no `/etc/spiceroute-app.env` on this box (that file
gets written by the launch template's user data, per instance). Now bake the
AMI:

1. Back in the EC2 console, select the `spiceroute-builder` instance → **Actions → Image and templates → Create image**.
2. **Image name**: `spiceroute-app-golden-ami`.
3. Create image. Wait for it to reach **Available** under **AMIs**.
4. Once the AMI is available, **terminate** the `spiceroute-builder` instance (no need to keep paying for it) — you can also delete the `spiceroute-app-build-<suffix>` S3 bucket now if you don't plan to rebuild the AMI.

---

## Phase 8 — IAM role for the app instances

1. **IAM → Roles → Create role** → Trusted entity: **AWS service** → **EC2**.
2. Name it `spiceroute-app-role`.
3. Add an inline policy (JSON tab) — replace `ACCOUNT_ID`:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": ["ssm:GetParameter"],
         "Resource": "arn:aws:ssm:us-east-2:ACCOUNT_ID:parameter/spice-route-kitchen/db/password"
       },
       {
         "Effect": "Allow",
         "Action": ["kms:Decrypt"],
         "Resource": "arn:aws:kms:us-east-2:ACCOUNT_ID:alias/aws/ssm"
       }
     ]
   }
   ```
   Name it `spiceroute-app-ssm-read`.
4. Create role.

This is intentionally the *only* thing the app instances can do in AWS: read
one parameter and decrypt it. No S3, no other tables, no admin anything.

---

## Phase 9 — Launch template

1. **EC2 → Launch Templates → Create launch template**.
2. **Name**: `spiceroute-app-lt`.
3. **AMI**: select `spiceroute-app-golden-ami` from **My AMIs**.
4. **Instance type**: `t3.micro`.
5. **Key pair**: same one from Phase 5 (or none — you won't normally need to SSH into these; add the SSM interface endpoint's siblings later if you want Session Manager access instead).
6. **Network settings**: security group → select existing → `spiceroute-app-sg`. *(Don't set a subnet here — the Auto Scaling Group controls that in Phase 11.)*
7. **Advanced details → IAM instance profile**: `spiceroute-app-role`.
8. **Advanced details → User data**:
   ```bash
   #!/bin/bash
   cat > /etc/spiceroute-app.env <<EOF
   PORT=3000
   DB_HOST=<your-rds-endpoint>
   DB_PORT=5432
   DB_NAME=spice_route_kitchen
   DB_USER=spiceroute_app
   DB_PASSWORD_PARAM=/spice-route-kitchen/db/password
   AWS_REGION=us-east-2
   EOF
   systemctl start spiceroute-app
   ```
9. Create launch template.

---

## Phase 10 — Target group and Application Load Balancer

1. **EC2 → Target Groups → Create target group**.
   - Type: **Instances**. Name: `spiceroute-app-tg`. Protocol/port: **HTTP 3000**. VPC: `spiceroute-vpc`.
   - Health check path: `/health`.
   - Skip registering targets manually (the Auto Scaling Group does this in Phase 11) → Create.
2. **EC2 → Load Balancers → Create load balancer → Application Load Balancer**.
   - Name: `spiceroute-alb`. Scheme: **Internet-facing**.
   - VPC: `spiceroute-vpc`. Subnets: `spiceroute-public-A` and `spiceroute-public-B`.
   - Security group: `spiceroute-alb-sg` only (remove default).
   - Listener: HTTP :80 → forward to `spiceroute-app-tg`.
   - Create load balancer.

---

## Phase 11 — Auto Scaling Group

1. **EC2 → Auto Scaling Groups → Create Auto Scaling group**.
2. Name: `spiceroute-app-asg`. Launch template: `spiceroute-app-lt`.
3. VPC: `spiceroute-vpc`. Subnets: `spiceroute-private-app-A` and `spiceroute-private-app-B` (**not** the public ones).
4. **Attach to an existing load balancer** → select `spiceroute-app-tg` target group. Turn on **ELB health checks**.
5. **Group size**: Desired 2, Min 2, Max 4.
6. **Scaling policies**: Target tracking → metric type **Average CPU utilization** → target value `50`.
7. Create Auto Scaling group.
8. Watch **EC2 → Instances** — two instances should launch into the private app subnets, and **EC2 → Target Groups → spiceroute-app-tg → Targets** should show both turning **healthy** within a minute or two of boot (systemd starting the app + the ALB health check hitting `/health`).

---

## Phase 12 — Test it

1. **EC2 → Load Balancers → spiceroute-alb** → copy the **DNS name** (e.g. `spiceroute-alb-123456789.us-east-2.elb.amazonaws.com`).
2. Open it in a browser — you should see the Spice Route Kitchen site, images and all.
3. Fill out the **Reserve a table** form and submit — you should get a confirmation message.
4. Reload the page and resubmit for the same date/time — this exercises the `/api/reservations/availability` read path too, confirming the app tier is really talking to RDS.
5. If something's wrong: check **Target Groups → Targets** for unhealthy instances first (usually a security group or systemd/user-data issue), then use **EC2 Instance Connect** on one of the ASG instances (temporarily add an inbound SSH rule to `spiceroute-app-sg` from your IP, revert after) and run `sudo systemctl status spiceroute-app` / `sudo journalctl -u spiceroute-app -n 50`.

---

## What this demonstrates (useful for a portfolio writeup)

- A full 3-tier VPC design (public/private/data subnet separation) with
  Multi-AZ high availability on the load balancer and compute tiers.
- EC2 Auto Scaling with a real target-tracking policy, vs. Lambda's
  concurrency-based scaling in the serverless project — a deliberate,
  explainable architectural choice.
- A NAT-free private tier using a VPC interface endpoint, with the resulting
  cost trade-off understood and stated explicitly rather than accepted by
  default.
- A "golden AMI" build/bake pattern, separating the internet-connected build
  environment from the fully private runtime environment.
- Defense in depth on secrets: master DB credentials never leave Secrets
  Manager / your own console session; the app-tier IAM role can only read
  and decrypt one specific parameter; the app connects to Postgres as a
  scoped-down user, never the RDS admin.

## Rough costs (running continuously)

| Resource | Approx. cost |
|---|---|
| RDS `db.t3.micro`, single-AZ | ~$12-13/month (or free tier eligible on a new account) |
| 2x EC2 `t3.micro` (ASG desired=2) | ~$15/month (or free tier eligible) |
| Application Load Balancer | ~$16-17/month + a small per-GB charge |
| SSM interface VPC endpoint (2 AZs) | ~$14.60/month + minimal data processing |
| S3 (build bucket, can delete after AMI bake) | pennies |
| **Total** | **roughly $45-60/month** if left running — vs. ~$65-70/month for the same design with a NAT Gateway per AZ |

This is a real, ongoing cost (unlike the serverless/static projects, which
sit near $0 at rest). **Tear it down when you're done demoing** — see below.

## Teardown (to stop charges)

Delete in this order: **Auto Scaling Group** (this terminates the EC2
instances) → **Load Balancer** → **Target Group** → **RDS instance** (skip
the final snapshot if you don't need it) → **VPC endpoint** → **NAT
Gateway** (none, in this design) → **Launch template** / **AMI** (deregister
+ delete the backing snapshot) → **VPC** (deleting the VPC cleans up
subnets, route tables, and the internet gateway together, once nothing else
references them).
