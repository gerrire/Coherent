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

## Test email confirmation

The staging API uses `APP_ENV=staging` and
`TEST_EMAIL_VERIFICATION_BYPASS=true`. Registration and profile email changes
accept any unused, syntactically valid address and any six ASCII digits instead
of a delivered code. No email is sent for these test requests. The UI identifies
this mode from the API response and shows that any six digits are accepted.
Passwords, CSRF, address binding, expiry, one-time challenges, uniqueness and
request limits remain enforced. A profile email change still needs the current
password. An address already belonging to another account cannot be claimed.

This flag defaults to false. Production Compose explicitly sets it to false,
and `APP_ENV=production` refuses to start if the flag is enabled. Staging keeps
the same encryption, secret, HTTPS and secure-cookie requirements as production.
The mode depends on the API configuration, not a Git branch name or client-side
flag, so merging the code into `main` does not enable it on the main site.
Test challenges carry a separate marker: switching the mode on does not bypass
real codes, and switching it off invalidates outstanding test codes. The data
schema is unchanged; staging accounts stay in its separate database.

For local testing, explicitly set `APP_ENV=development` and
`TEST_EMAIL_VERIFICATION_BYPASS=true`; the checked-in `.env.example` leaves it off.

For an **existing installed staging stack**, the owner must apply the reviewed
`APP_ENV: staging` and `TEST_EMAIL_VERIFICATION_BYPASS: "true"` environment settings
to `/var/lib/coherent-staging/stack/compose.yaml` and recreate its API using the
reviewed image. `deploy-reviewed` builds images but does not replace the installed
Compose file. Deploy code that supports these settings before enabling them.
A push to `Gleb_test` alone does not activate the mode on the running test site.

## Architecture

The `coherent-staging` Compose project lives in a separate rootless Docker
daemon under Linux user `coherent-stage`. It owns its PostgreSQL, Redis,
LiveKit, API, frontend, Mailpit, volumes and networks. The API and Mailpit
sit on an internal network. The rootless account is outside the production
Docker and sudo groups. A separate nftables table rejects connections from
that account to host services and private networks. Its daemon also has a
dedicated network namespace. nftables forwards the exact media ports and
filters traffic from the staging link.

The VPS uses 2 vCPUs and 4 GiB RAM. The staging user slice is capped at one
CPU, 1.5 GiB RAM, 256 MiB swap and 768 tasks. The daemon, application volumes
and build cache share a separate 7 GiB ext4 filesystem. Compose adds
per-service memory, task and logging limits. The production SMTP service
retains its existing configuration.

The existing Caddy serves staging HTTPS on port 443. It forwards to
`10.205.40.2:18080` and removes its access credential from upstream requests.
The refresh timer validates the combined configuration before reloading
Caddy and reapplies the staging route when production restarts or replaces its Caddy
container. LiveKit signaling validates its own room JWTs, so WebSocket
connections work without the site's HTTP authentication challenge. LiveKit
has separate credentials and uses TCP 17881, UDP 17882
and TURN UDP 13478 with relay ports 14000–14031. The production media ports belong to its existing server.

## Developer workflow

Use `Gleb_test` in the developer's fork and open a pull request targeting
`Gleb_test` in Coherent. The owner reviews the code and workflow changes
before accepting the revision into the shared repository. Check the
**Build for deployment** run for the accepted commit under GitHub Actions.
Use the staging site and inbox after the owner deploys that commit. To
report a failure, include the time, commit SHA and steps to reproduce.

Automatic deployment from arbitrary pushes is disabled. The shared
repository still has repository-level desktop signing secrets and the
developer already has write access. An unreviewed push to this repository
can modify workflows. The fork workflow is a process boundary until
the owner removes direct write access or moves signing to a separately
protected workflow. Staging automation also needs a repository where the
developer's token cannot change production releases. For unrestricted
developer-controlled frontend deployments, use a separate registered
domain so the staging page cannot set cookies for production's parent
domain.

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
coherent-staging chat-mode mls
coherent-staging chat-mode cloud
journalctl -u coherent-staging-proxy.service -n 50
```

The initial chat mode matches production's cloud mode. To test device
recovery and legacy MLS, close active staging calls and switch staging to
`chat-mode mls`. Use test accounts with verified addresses. Switch back
with `chat-mode cloud` when finished. The command edits the policy row in
`coherent_staging` and preserves existing data.

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

To withdraw the staging route, run the following on the VPS. The refresh
service stores the original production Caddyfile at
`/etc/coherent-staging/production.Caddyfile`. The existing production
container also includes its original configuration.

```sh
systemctl disable --now coherent-staging-proxy.timer
flock /run/lock/coherent-deploy.lock bash -c '
  set -e
  docker exec coherent-web-1 caddy validate --config /etc/caddy/Caddyfile
  docker exec coherent-web-1 caddy reload --config /etc/caddy/Caddyfile
  rm -f /run/coherent-staging-proxy-state
'
```

Re-enable the route with `systemctl enable --now coherent-staging-proxy.timer`
and `systemctl start coherent-staging-proxy.service`. Staging data remains
on its mounted filesystem for recovery.
