# Coherent staging

Staging is available at https://dev.coherent-web.ru. Use a separate browser
profile with test accounts. The HTTPS gateway requests the staging access
credentials before serving the application. The owner can share those
credentials privately. Access to the test site requires no VPS account.

- Application and API: `https://dev.coherent-web.ru/` and `/api/v1/`.
- LiveKit signaling: `wss://dev.coherent-web.ru/livekit`.
- Test mail: `https://dev.coherent-web.ru/__mailpit/`. Mailpit retains up to
  100 messages for seven days. SMTP stays on the staging Docker network.
- Health: `/api/v1/health/ready`.

## Architecture

The `coherent-staging` Compose project lives in a separate rootless Docker
daemon under Linux user `coherent-stage`. It owns its PostgreSQL, Redis,
LiveKit, API, frontend, Mailpit, volumes and networks. The API and Mailpit
sit on an internal network. The rootless account is outside the production
Docker and sudo groups. A separate nftables table rejects connections from
that account to host services and private networks.

The VPS uses 2 vCPUs and 4 GiB RAM. The staging user slice is capped at one
CPU, 1.5 GiB RAM, 256 MiB swap and 768 tasks. The daemon, application volumes
and build cache share a separate 7 GiB ext4 filesystem. Compose adds
per-service memory, task and logging limits. The production SMTP service
retains its existing configuration.

The existing Caddy serves staging HTTPS on port 443. It forwards to
`127.0.0.1:18080` and removes its access credential from upstream requests.
The refresh timer validates the combined configuration before reloading
Caddy and reapplies the staging route when production replaces its Caddy
container. LiveKit has separate credentials and uses TCP 17881, UDP 17882
and TURN UDP 13478. The production media ports belong to its existing server.

## Developer workflow

Push application changes to `Gleb_test` and check the **Build for deployment**
run for that exact commit under GitHub Actions. Pass the commit SHA to the
owner for review. Use the HTTPS site and the test inbox after the owner
deploys it. For an error, share the time, commit SHA and steps to reproduce.
The owner can read API, web and LiveKit logs using the commands below.

An automatic deployment from arbitrary pushes is disabled. The shared
GitHub repository has repository-level desktop signing secrets and the
second developer has repository write access. A branch can modify its
workflows and request its own token permissions. Branch naming and the
rootless daemon do not protect GitHub credentials or production release
assets. Automatic staging needs a separate GitHub trust boundary for the
developer and staging workflows. The staging site also shares a cookie
parent domain with production. Keep public staging revisions reviewed, or
place arbitrary developer-controlled frontends on a separate registered
domain before enabling automatic public deployments.

## Owner operations

On the VPS, these commands use the staging daemon only:

```sh
coherent-staging status
coherent-staging logs api
coherent-staging logs livekit
coherent-staging restart
coherent-staging stop
coherent-staging start
coherent-staging rollback
journalctl -u coherent-staging-proxy.service -n 50
```

To deploy an approved SHA, fetch `Gleb_test` locally and create an uncompressed
archive of the exact reviewed commit:

```sh
git fetch origin Gleb_test
git archive --format=tar --output=coherent-reviewed.tar REVIEWED_SHA
```

Transfer it to the owner's private VPS directory and run
`coherent-staging deploy-reviewed /root/coherent-reviewed.tar`. The command
requires successful branch CI for the exact commit, builds under the
resource-limited rootless account, applies Alembic, checks readiness and
records the previous revision. Review DB migrations for compatibility
with the preceding app before deployment. Rollback switches application
images and leaves staging database migrations in place.

To withdraw the staging route, disable the refresh timer, remove its state
marker, then validate and reload the production container's original Caddy
configuration under the production deployment lock. Staging data remains
on its mounted filesystem for recovery.
