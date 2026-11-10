# Automatic GCP VM deployment

`.github/workflows/deploy-vm.yml` deploys every commit pushed to `main`. It checks out that exact revision in GitHub Actions, authenticates to Google Cloud with Workload Identity Federation, opens an IAP SSH session, fast-forwards the VM checkout, builds Compose images with one build at a time, runs migrations through Compose, and checks the public health endpoint. Pull requests do not deploy. `workflow_dispatch` can be used to rerun a deployment from `main`.

The workflow uses a dedicated Google service account and does not store a service-account JSON key in GitHub. Restrict the Workload Identity provider to this repository and the `main` ref.

## One-time GCP setup

Run these commands in Cloud Shell or an administrator's authenticated `gcloud` terminal. The principal creating the IAM resources needs the corresponding IAM, Compute Engine, and Workload Identity permissions.

```bash
PROJECT_ID=chief-502717
POOL_ID=github-actions
PROVIDER_ID=attendance-call-service
DEPLOY_SA=github-vm-deploy
VM_NAME=brokers
VM_ZONE=asia-south1-c

gcloud config set project "$PROJECT_ID"
gcloud services enable \
  compute.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  iap.googleapis.com

gcloud iam service-accounts create "$DEPLOY_SA" \
  --project "$PROJECT_ID" \
  --display-name "GitHub Actions VM deploy"

gcloud iam workload-identity-pools create "$POOL_ID" \
  --project "$PROJECT_ID" --location global \
  --display-name "GitHub Actions deployments"

gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID" \
  --project "$PROJECT_ID" \
  --location global \
  --workload-identity-pool "$POOL_ID" \
  --display-name "Attendance service main branch" \
  --issuer-uri "https://token.actions.githubusercontent.com" \
  --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
  --attribute-condition "assertion.repository == 'chiefxai/attendance-call-service' && assertion.ref == 'refs/heads/main'"

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
DEPLOY_SA_EMAIL="${DEPLOY_SA}@${PROJECT_ID}.iam.gserviceaccount.com"
POOL_MEMBER="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.repository/chiefxai/attendance-call-service"

gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA_EMAIL" \
  --project "$PROJECT_ID" \
  --member "$POOL_MEMBER" \
  --role roles/iam.workloadIdentityUser

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member "serviceAccount:${DEPLOY_SA_EMAIL}" \
  --role roles/compute.viewer

gcloud compute instances add-iam-policy-binding "$VM_NAME" \
  --project "$PROJECT_ID" --zone "$VM_ZONE" \
  --member "serviceAccount:${DEPLOY_SA_EMAIL}" \
  --role roles/compute.osAdminLogin

gcloud compute instances add-iam-policy-binding "$VM_NAME" \
  --project "$PROJECT_ID" --zone "$VM_ZONE" \
  --member "serviceAccount:${DEPLOY_SA_EMAIL}" \
  --role roles/iap.tunnelResourceAccessor
```

### OS Login and existing administrator access

The workflow uses OS Login and IAP, so port 22 does not need to be publicly open. Before enabling OS Login, grant the human administrators who need VM access the appropriate OS Login and IAP roles, and confirm they can connect. Enabling OS Login on a VM disables metadata-based SSH keys and removes their `authorized_keys` entries; enabling it without arranging administrator access can lock out existing SSH users. See [Google's OS Login role requirements and behavior](https://docs.cloud.google.com/compute/docs/oslogin/set-up-oslogin).

Once administrator access is confirmed, enable OS Login on this VM only:

```bash
gcloud compute instances add-metadata brokers \
  --project chief-502717 --zone asia-south1-c \
  --metadata enable-oslogin=TRUE
```

Allow the IAP TCP forwarding range to reach TCP 22 in the VM's VPC firewall (`35.235.240.0/20`). Do not open SSH to `0.0.0.0/0`.

The deployment service account also needs `roles/iam.serviceAccountUser` on the service account attached to the VM. Find that account with:

```bash
gcloud compute instances describe brokers \
  --project chief-502717 --zone asia-south1-c \
  --format='value(serviceAccounts[0].email)'
```

Then grant the role on that service account resource:

```bash
VM_SERVICE_ACCOUNT='PASTE_THE_EMAIL_FROM_THE_COMMAND_ABOVE'
gcloud iam service-accounts add-iam-policy-binding "$VM_SERVICE_ACCOUNT" \
  --project chief-502717 \
  --member='serviceAccount:github-vm-deploy@chief-502717.iam.gserviceaccount.com' \
  --role roles/iam.serviceAccountUser
```

The Linux user `elvoryxinfotech` must own the deployment checkout and be able to run `sudo docker compose` without an interactive password, as in the current manual deployment. The checkout must be on `main`, and `.env` plus `docker-compose.vertex-credentials.yml` must already be present on the VM.

## GitHub repository variables

In **Settings → Secrets and variables → Actions → Variables**, add:

| Variable | Value |
| --- | --- |
| `GCP_PROJECT_ID` | `chief-502717` |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/<project-number>/locations/global/workloadIdentityPools/github-actions/providers/attendance-call-service` |
| `GCP_DEPLOY_SERVICE_ACCOUNT` | `github-vm-deploy@chief-502717.iam.gserviceaccount.com` |
| `GCP_VM_NAME` | `brokers` |
| `GCP_VM_ZONE` | `asia-south1-c` |
| `GCP_DEPLOY_USER` | `elvoryxinfotech` |
| `GCP_DEPLOY_PATH` | `/home/elvoryxinfotech/attendance-call-service-deploy-1ac81d5` |
| `PUBLIC_HEALTH_URL` | `https://calls.elvoryx.in/healthz` |

Get the project number and provider resource name using:

```bash
gcloud projects describe chief-502717 --format='value(projectNumber)'
gcloud iam workload-identity-pools providers describe attendance-call-service \
  --project chief-502717 --location global \
  --workload-identity-pool github-actions --format='value(name)'
```

After the workflow is merged to `main`, every merge to `main` will start the deploy job. Watch it under the repository's **Actions** tab. A failed SSH, Compose build, migration, or health check fails the workflow and includes recent service logs in the run output.
