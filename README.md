# VZ

A Void + React platform for full Vite/Rolldown build diagnostics. The Vite plugin
captures CI builds, authenticates with GitHub Actions OIDC, and uploads resumable
artifacts to Cloudflare R2. D1 stores projects, report metadata, and upload state.

Each app in a GitHub repository has its own project and build history. Public repo
reports are readable anonymously, including source. Private reports require GitHub
sign-in and current repository access. Completed reports stay until a maintainer
deletes them. Local uploads and live sessions are intentionally deferred.

## Develop

Use the Node version in `.node-version` and the [Vite+ CLI](https://viteplus.dev/guide/global-cli).

```sh
vp install
vp exec void db migrate
vp -C . dev
```

Open http://localhost:5173. The unconfigured platform shows an empty workspace and
setup guide; GitHub-backed operations require the configuration below. No fixtures
or authentication bypasses are enabled in the application.

If an older Node on PATH makes install lifecycle scripts fail, first activate
Node 26.13.1; alternatively run `vp install --ignore-scripts` followed by
`vp exec void prepare`. Dependency build scripts must already have run before
using that workaround.

```sh
vp check --deny-warnings
vp test --config vitest.config.ts
vp run pack:plugin
vp -C . build
```

The workspace root hosts the platform; explicit `-C .` selects it for Vite+ dev,
build, and preview commands. The plugin is in `packages/vite-plugin-vz`, with its
shared versioned protocol in `packages/protocol`. See the plugin README for usage.
The distribution has not been published; use its packaged tarball for development.

## GitHub App

Register a **public GitHub App** that can be installed on selected repositories.
Configure:

- Callback URL: `https://<platform-host>/api/auth/callback/github`
- Setup URL: `https://<platform-host>/`
- Webhook URL: `https://<platform-host>/api/github/webhook`, with a generated secret
- Repository permissions: Metadata read and Contents read
- Account permission: Email addresses read (required by the GitHub sign-in provider)
- Events: Repository, plus installation and installation repository events delivered
  automatically by GitHub
- Expiring user access tokens enabled; user authorization during installation enabled

The same App's client ID and client secret power browser sign-in through Void's
Better Auth integration. App installation tokens only establish the app's access;
private report views additionally use the signed-in user's App token. Tokens are
stored encrypted by Better Auth and refreshed through its account API.

Webhook deliveries update repository selection, installation suspension/removal,
repository names, transfers, and visibility. Every report, dataset, download, and
comparison independently verifies current GitHub access and fails closed on errors.
The R2 bucket is private, and responses use `Cache-Control: no-store`.

## Configuration and Cloudflare deployment

Declare local values in the root `.env` (gitignored). Generate unique values for
`UPLOAD_SECRET` (at least 32 random characters) and `GITHUB_WEBHOOK_SECRET`.

```ini
PLATFORM_ORIGIN=https://<platform-host>
GITHUB_APP_ID=<numeric-app-id>
GITHUB_APP_SLUG=<app-slug>
GITHUB_APP_PRIVATE_KEY="<PEM-private-key-with-escaped-newlines>"
GITHUB_WEBHOOK_SECRET=<webhook-secret>
AUTH_GITHUB_CLIENT_ID=<app-client-id>
AUTH_GITHUB_CLIENT_SECRET=<app-client-secret>
UPLOAD_SECRET=<random-upload-signing-key>
```

`PLATFORM_ORIGIN` must be the canonical HTTPS origin. It is the exact OIDC audience
and report URL origin. GitHub's PKCS#1 and PKCS#8 PEM keys are supported.

For deployment, configure these names with `vp exec void secret put NAME` against
the selected Cloudflare destination. Never commit credentials. Optional schema keys
allow the workspace to run without credentials; protected operations return a
configuration error until all required values are set.

The checked-in D1 migrations include application and Better Auth tables.
Artifact descriptors occupy individual rows, keeping each build metadata row bounded
even for manifests with thousands of source files.
Void infers `DB` from `void/db` and the private `STORAGE` R2 bucket from `void/storage`.
There are no separate R2/S3 signing credentials to distribute: artifact parts pass
through the Worker and stream/hash against R2. Provision no public R2 domain.

```sh
vp exec void connect
vp exec void deploy --platform cloudflare
```

Select the Cloudflare account when prompted. Before the first production deploy,
use a separate staging Worker, D1 database, R2 bucket, and GitHub App configuration.
Install that app on a test repository, run a workflow with `id-token: write`, and
verify public access, private collaborator access, revocation, and deletion.
Live GitHub/Cloudflare validation requires those external accounts and secrets;
the local suite uses signed test JWTs, SQLite, and an in-memory R2 adapter.

## Upload and read APIs

All platform routes are under `/api/v1`:

| Method | Route                                          | Authorization                                          |
| ------ | ---------------------------------------------- | ------------------------------------------------------ |
| POST   | `/uploads`                                     | GitHub Actions OIDC                                    |
| PUT    | `/uploads/:id/artifacts/:artifact/parts/:part` | Scoped, expiring upload token                          |
| POST   | `/uploads/:id/artifacts/:artifact/complete`    | Scoped upload token                                    |
| POST   | `/uploads/:id/complete`                        | Scoped upload token                                    |
| GET    | `/projects`, `/projects/:id/builds`            | Current repository visibility/access                   |
| GET    | `/builds/:id`                                  | Current repository visibility/access                   |
| GET    | `/builds/:id/datasets/:dataset?page=0`         | Current repository visibility/access                   |
| GET    | `/builds/:id/artifacts/:artifact`              | Current repository visibility/access                   |
| GET    | `/builds/:id/compare?before=<build-id>`        | Access to both reports                                 |
| DELETE | `/builds/:id`                                  | GitHub repository write access and same-origin request |

OIDC signatures, issuer, audience, expiration, immutable repo/owner IDs, and app
installation are verified before accepting a capture. Repository identity and
workflow provenance come from signed claims; checkout SHA is separately reported.
A workflow identity authorizes publication for its repo; it does not attest to the
correctness of diagnostic contents or checkout choices made by the workflow.

A manifest declares protocol/producer versions, app/environment, summaries, and
artifact byte sizes and SHA-256 hashes. Multipart uploads use 8 MiB parts, three
parallel artifact workers, and bounded retry backoff. Dataset pages are at most
512 KiB; source and compressed native JSONL are separate immutable artifacts.
Artifact completion streams SHA-256 verification before publication. Captures only
become readable once every artifact is complete. Duplicate capture initialization,
part uploads, and sequential completion retries are idempotent. Credentials expire
after two hours; a new OIDC initialization for the same manifest renews them.

Reports support module/chunk graphs, size maps, package versions, plugin timings,
source transforms, raw downloads, and comparisons. Hook totals can exceed wall time
because hooks overlap; module rendered sizes and final asset sizes measure different
stages. Comparisons default to a preceding build from the same app, environment,
and branch, or an explicitly selected compatible report.

Completed reports have no automatic expiry. The hourly cleanup job removes
abandoned uploads older than 24 hours and resumes interrupted report deletions.
Artifacts are limited to 5 GiB each and 20,000 per manifest; datasets are paged so
interactive requests never parse a full native log. Raw downloads stream from R2;
source previews use byte ranges. Configure Worker CPU limits for the largest
captures you intend to accept, since final checksum verification reads each object.

## Main-branch timelines

Each project page includes live time series for completed uploads on `main`.
Client and server environments remain separate. The build overview plots output
size, duration, module/chunk/asset counts, and package counts. The dataset explorer
plots numeric measurements for modules, chunks, assets, package versions, plugin
hooks, event groups, stored artifact kinds, and process memory/CPU snapshots.
Select a point to open its report. Search records, switch metrics/environments or
branches, and load older history without dropping points. Content-hashed filenames
are separate entities. Missing runtime data is a gap, while a removed indexed record
has a zero value. Each capture is a point, including reruns of the same commit.

The view refreshes every 15 seconds while visible. Measurements are indexed when
an upload completes; chart requests read D1 rather than historical R2 objects.
Existing reports backfill in the background when viewed and during hourly cleanup.
Repository visibility and user access are still verified for every chart request.
Deleting a report also deletes its indexed measurements.

An enabled plugin in a workflow triggered by `push` to `main` automatically adds
points after successful uploads. `Boshen/vz-test` provides that live fixture and
verifies the resulting series. No additional chart-upload credentials are needed.

VZ also tracks itself: pushes to this repository's `main` upload the complete
platform build to the `vz` project at `https://vz.void.app`, with client and Worker
environments separated. The workflow grants OIDC only to its build job and enables
capture only for main-branch pushes; pull-request and local builds do not upload.
Small artifacts use checksum-verified batches when the platform advertises support;
large artifacts retain resumable multipart uploads. Timeline indexing checkpoints
its measurements and database writes; the plugin polls until the complete index
is published, so large captures can resume after a request failure.

## Regression detection

Main reports compare output size and build duration with the preceding completed
capture from a different main commit in the same project and environment. Ordering
uses capture timestamps, with build IDs breaking ties; this is upload history, not
Git ancestry. Reruns of the current commit are excluded from baseline selection.
Feature branches and other projects/environments cannot supply a baseline.

A warning requires both thresholds:

- Output size: at least 5% growth and at least 10 KiB (10,240 bytes).
- Build duration: at least 20% growth and at least 100 ms.

A zero baseline uses the absolute floor. The first main commit establishes a
baseline. Improvements and increases below either floor do not trigger warnings.
Policies live in `src/regressions.ts`. The report and project dashboard show the
baseline and measured deltas; amber size/timing points mark historical regressions.
`GET /api/v1/builds/:id/regressions` applies normal current repository authorization.
The main workflow writes report links/statuses to its job summary and emits GitHub
warning annotations for flagged metrics. Threshold violations do not fail CI.
