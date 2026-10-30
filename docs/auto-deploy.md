# Relay automatic deployment

Relay deploys automatically through **GitHub Actions**, using the same CI-gated production pattern as Atlas. No VPS cron, polling timer, webhook service or GitHub runner on the VPS is needed.

## Process

1. A change is merged into the `affank1020/relay` `main` branch.
2. Relay's `Verify` workflow runs tests, validates Caddy and Compose, and builds the Docker image.
3. **Only a successful push-triggered `Verify` run on `main`** triggers `Relay Deploy`.
4. The deploy job connects to the VPS using pinned SSH host keys. It checks a clean Relay checkout, confirms the current GitHub `main` SHA equals the exact successful CI commit and checks fast-forward ancestry.
5. It invokes `~/relay/scripts/deploy.sh --ingress --no-pull`. That script rebuilds on the VPS, checks the API process and verifies the private gateway's injected Relay token.
6. If deployment fails, the workflow attempts to restore the previous commit and containers and exits with failure. If the release is already superseded by a newer commit, the old CI run safely skips deployment.

## One-time GitHub configuration

The Atlas deployment credentials **cannot automatically be shared across separate GitHub repositories**. You must configure these four repository or `production` environment secrets in **Relay's** GitHub settings (Settings → Secrets and variables → Actions):

| Name | Purpose |
|---|---|
| `VPS_HOST` | VPS hostname or IP |
| `VPS_USER` | Existing non-root VPS SSH user |
| `VPS_SSH_PRIVATE_KEY` | Matching private SSH key for that VPS user |
| `VPS_SSH_KNOWN_HOSTS` | Pinned, independently verified SSH host-key entry for the VPS |

These are the same **secret names** used by Atlas. GitHub does not expose the existing Atlas secret values to copy them automatically. Configure a dedicated Relay deploy key if you prefer isolation. Do not paste any keys or secrets into ChatGPT, issues, comments or commits.

The workflow uses GitHub environment `production` and accepts secrets configured at repository or environment scope. The VPS account must already be able to run Docker and `git fetch origin main` for its existing `~/relay` checkout.

## Testing and monitoring

- `Actions → Verify`: the CI check.
- `Actions → Relay Deploy`: the release deployment, skipped when CI failed.
- If deployment fails due to missing secrets, it stops **before connecting to production**; configure the missing values and trigger a fresh successful `Verify` run on `main`.
- `~/relay/.env` stays **only on the VPS**, and shared human credentials remain owned by `~/vps-infra/.env`. Neither secret file is copied to GitHub.
- `~/relay` must be a clean checkout of `main`; the workflow refuses to overwrite tracked changes.
- Rebuilds restart Relay. Sessions are currently in memory, so conversations can be cleared on release until persistence is added.

There is no VPS timer to enable, and no need to run `./scripts/deploy.sh --ingress` after future merges once the GitHub secrets are configured.
