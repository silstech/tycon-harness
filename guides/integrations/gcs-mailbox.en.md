# The runs mailbox on Google Cloud Storage

In Spanish: [gcs-mailbox.md](gcs-mailbox.md).

For a team whose cloud is GCP: the machines upload their runs to a Cloud Storage bucket and the organization site, on
Cloud Run, reads them. The connector lives in `integrations/gcs/` (type `mailbox`, provider `gcs`); the harness core
does not name it. Azure Blob Storage stays as it is.

## What to create in GCP

1. **The bucket.** Private, with no public access, with uniform bucket-level access. For example
   `gcloud storage buckets create gs://<bucket> --uniform-bucket-level-access --public-access-prevention`.
2. **A custom role with a single permission: `storage.objects.create`.** No reading, listing or deleting: the upload
   account only creates new objects. Without `storage.objects.delete` it cannot overwrite one that already exists
   either.
   `gcloud iam roles create buzonSoloCrear --project <proyecto> --permissions storage.objects.create`
3. **A service account for the upload**, with that role granted **on the bucket** (not on the project):
   `gcloud storage buckets add-iam-policy-binding gs://<bucket> --member serviceAccount:<cuenta> --role projects/<proyecto>/roles/buzonSoloCrear`
4. **Its HMAC key** (`gcloud storage hmac create <cuenta>`): it gives the access id and the secret that go in the key
   file. The key is revoked by **deactivating it** (`gcloud storage hmac update <id> --deactivate`); only once it is
   deactivated can it be deleted. To rotate: create a new key, change the key file, deactivate the old one.
5. **The bucket reader role for the site's identity**: the service account the Cloud Run service runs as gets
   `roles/storage.objectViewer` on the bucket. The site uses no key: it asks its environment's metadata server for the
   token of its identity.
6. **The bucket reader role for each person who downloads the mailbox to their machine**: their Google account gets
   `roles/storage.objectViewer` on the bucket (not on the project):
   `gcloud storage buckets add-iam-policy-binding gs://<bucket> --member user:<correo> --role roles/storage.objectViewer`.
   See «Downloading from a machine», below.

## The machines' key

`scripts/metrics/corridas-buzon.json` in the team layer, like the Azure one, with a different shape:

```json
{
  "provider": "gcs",
  "bucket": "<bucket>",
  "accessId": "<id de la clave HMAC>",
  "secret": "<secreto de la clave HMAC>",
  "vence": "AAAA-MM-DD",
  "rotar": "crear una clave HMAC nueva, cambiar esta llave y desactivar la vieja"
}
```

- `vence` is the rotation date the team sets (an HMAC key does not expire on its own); 30 days before, the upload
  warns, the same as with Azure.
- A field that is missing or has another shape is `config_ilegible`, with the field named. No message repeats a value
  from the key: the secret never comes out.
- Before each batch the upload tries to **list** the bucket and only goes on if the answer is 403 `AccessDenied`: a key
  that can list is not the mailbox key (it exits 2, `llave_con_lectura`, without uploading anything). Then it asks by
  name for an object that does not exist, under the machine's folder (this way a read granted by prefix or by managed
  folder also shows), and for one that machine already uploaded: the create-only account answers 403 `AccessDenied` to
  both; one that reads objects without being able to list them answers 404 `NoSuchKey` or 200, and also exits 2.
  `--check-create-only` goes through the same tests.
- **A bucket without uniform access leaves the machines unable to upload.** With per-object permissions, whoever uploads
  an object can read it; since the key is a single one for all machines, it would read the other machines' runs. So,
  from each machine's second batch on, the upload exits 2 (`llave_con_lectura`) and says so. It is fixed by turning on
  the bucket's uniform access (`gcloud storage buckets update gs://<bucket> --uniform-bucket-level-access`).

## The team profile

`operations.json`, section `site.mailbox`:

```json
{ "provider": "gcs", "bucket": "<bucket>", "threads": false }
```

The machines' key and `site.mailbox.bucket` name **the same bucket**: the upload uses the key's and the site uses the
profile's, and they do not cross. The site runs with `SITE_MAILBOX_IDENTITY=managed` (the identity of the environment
where it runs). Outside GCP there is no metadata server: the site says `sin_configurar` after 2 seconds, without
hanging.

## Checking that the key only creates

From a machine with the key installed and something already uploaded:

```bash
node scripts/metrics/upload-runs.js --check-create-only
```

It uploads again the same bytes of the smallest confirmed object, without the no-overwrite precondition. 403
`AccessDenied` (the account does not have `storage.objects.delete`) exits 0: the account only creates. 200 exits 1: the
account could overwrite, or the object was no longer there.

## The response codes

Measured on a lab bucket (`acme-buzon-lab` in the examples) with the XML API and an HMAC key:

| Situation | Response | What the upload does |
|---|---|---|
| New object | 200 | `creado`: only then is it written to the local log |
| The object already exists (`x-goog-if-generation-match: 0`) | 412 `PreconditionFailed` | `ya_existe`: a retry with a new version |
| The account cannot create | 403 `AccessDenied` | `llave_sin_permiso` |
| Listing with the create-only account | 403 `AccessDenied` | the pre-batch test passes |
| Reading by name an object that does not exist, with the create-only account | 403 `AccessDenied` | the pre-batch test passes |
| The same with an account that reads objects | 404 `NoSuchKey` | `llave_con_lectura`: exits 2, without uploading anything |
| Reading an object the machine already uploaded, in a bucket without uniform access | 200 | `llave_con_lectura`: exits 2 and asks to turn on uniform access |
| The signature does not match (wrong secret) | 403 `SignatureDoesNotMatch` | `llave_invalida` |
| The HMAC key is deactivated | 401 `KeyInactive` | `llave_invalida` |
| The bucket does not exist | 404 `NoSuchBucket` | `llave_invalida`, with the bucket in the reason |
| The Content-MD5 does not match | 400 `BadDigest` | the content did not arrive whole: it is not logged |
| The service failed | 5xx, 429, 408 | `servicio_fallo` |
| No response (network cut, timeout) | — | `sin_red` |

No response other than 200 marks the file as uploaded, and the exit code is not 0.

On the site side (JSON API, with its identity's token): 401 is `credencial_rechazada` (the token expired or is not
valid), 403 is `sin_permiso` (the identity does not have the reader role) and 404 is `sin_contenedor`. In all three the
pass is not complete and the site keeps showing the last thing it read whole.

No object is read past the size the listing gave. Cloud Storage serves decompressed an object stored with
`Content-Encoding: gzip`, so a few uploaded bytes can be many on download: the download cuts at the listed size and
that object counts as «llegó distinto» (arrived different). The others are downloaded anyway.

## Downloading from a machine

`download-runs.js` reads the bucket with **the person's gcloud session** (`gcloud auth login`), through the JSON API
and with the reader role from step 6. It uses the same key as the upload to know which bucket it is; it does not use
the HMAC key or ask for Azure DevOps. The mirror, the index and the rules are the Azure ones: the newest version of each
run and the newest set of logs that is complete.

gcloud runs with its input closed, `CLOUDSDK_CORE_DISABLE_PROMPTS=1` and a 45 s limit: it never opens a login or waits
for an answer. On Windows it works as with `az`: it calls `gcloud`, without looking for `gcloud.cmd`.

| Situation | What the download does |
|---|---|
| No gcloud, no session (or no token, or no answer in 45 s), or the account without the role (403) | `sin_permiso`: exits 0, does not create the folder and says so once a day |
| The token is rejected (401, when listing or downloading) | `credencial_rechazada`: exits non-zero |
| The bucket does not exist (404) | `sin_contenedor`, with the bucket in the reason: exits non-zero |
| No response | `sin_red`: exits non-zero |

**The difference from Azure is on purpose**: there, a 401 when listing exits 0, like a missing permission. Here the
token comes from a session that already answered, so a 401 is a token that expired or is not valid, and it exits
non-zero. A 401 in the middle of the pass cuts it: what was already downloaded stays, and the object that gave the 401
does not.

The `--overwrites-report` and `--harness-node-report` reports still read only Azure: with a gcs key they exit 1 with
`no_soportado`.

## The site on Cloud Run, kept up to date

The connector also brings the `cloudrun` platform of the site updater (`update-site.js --platform cloudrun
--service <servicio> --region <región> [--project <proyecto>]`, in `integrations/gcs/scripts/site-platform.js`). With
`site.update: "auto"`, the GitHub nightly process (`site-update.yml`, with `SITE_PLATFORM=cloudrun`):

- reads the image the service runs (`gcloud run services describe`) and resolves `stable` in the public registry;
- changes only the image, by digest (`gcloud run services update --image … --quiet`): it keeps the timeout, the
  variables and the secrets. If the service runs from a mirror (an Artifact Registry remote repository), it applies
  with that same mirror: the digest is the same in both;
- waits until the latest created revision is the ready one, is Ready, has that image and takes all the traffic; it runs
  the no-session test and, if it fails, goes back to the previous digest;
- does not touch a service with traffic pinned to a revision: it exits `no_pudo` with «el tráfico está fijado a una
  revisión» (traffic is pinned to a revision); `gcloud run services update-traffic <servicio> --to-latest` gives it
  back to the latest.

To set it up:

1. **A Workload Identity Federation pool** with a provider that trusts the operations repo and its `site-update`
   environment (with no stored service account key).
2. **A service account for the updater**, with a custom role on the site's service (`run.services.get` and
   `run.services.update`) and `iam.serviceAccounts.actAs` on the account the site runs as. If the service runs from a
   mirror (an Artifact Registry remote repository), also `roles/artifactregistry.reader` on **that repository**, not
   on the project: Cloud Run checks that whoever deploys can read the image, and without it changing the image and
   rolling back fail with `PERMISSION_DENIED` (`artifactregistry.repositories.downloadArtifacts`). Nothing else.
3. **The operations repo variables**: `SITE_PLATFORM=cloudrun`, `SITE_GCP_WIF_PROVIDER`
   (`projects/<número>/locations/global/workloadIdentityPools/<pool>/providers/<proveedor>`),
   `SITE_GCP_SERVICE_ACCOUNT`, `SITE_GCP_PROJECT`, `SITE_GCP_REGION`, `SITE_SERVICE`, `SITE_IMAGE_NAME` (the public
   image, where `stable` is read) and `SITE_URL`. The nightly process signs in with `google-github-actions/auth`
   (pinned by digest) and uses the Google Cloud tool the GitHub machine already has.

## What it does not do yet

- The Azure Pipelines nightly processes read only Azure: with a `site.mailbox` from another provider they warn that it
  is not supported (the dashboard and the learnings keep running without a mailbox; the runs review comes out red). The
  GitHub nightly processes do not read the mailbox.
- It does not delete or prune objects in the bucket: the upload only creates.
