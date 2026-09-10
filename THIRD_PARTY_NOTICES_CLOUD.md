# Cloud session dependencies

The cloud session implementation uses these packages under the MIT License. Their original license notices remain in the installed packages; no third-party implementation has been copied into this repository.

| Package | Version reviewed | Source | License |
| --- | --- | --- | --- |
| iron-session | 9.0.1 | https://github.com/vvo/iron-session/tree/v9.0.1 | MIT |
| iron-webcrypto (transitive) | 2.0.0 | https://github.com/brc-dd/iron-webcrypto | MIT |

`iron-session` supplies the authenticated encryption and versioned password support through `sealData` and `unsealData`. It requires Node.js 22.13 or later; its web-standard adapters also support Cloudflare Workers. This project's wrapper uses Node.js crypto and targets the private Node service.

The wrapper is for a single owner identified by service configuration. It keeps no credential database, revocation list, or filesystem account store. Removing a browser cookie or stored account envelope does not revoke previously copied valid envelopes and cookies; platform revocation or retiring their encryption key is required to invalidate those copies before expiry.

Account envelopes expire after 30 days and are limited to 8 MiB as serialized sealed strings. The browser should persist them only when the owner chooses to remember the account. The small service cookie is HttpOnly, Secure, SameSite=Strict and restricted to its host. A non-remembered session has no browser persistence attribute but still expires on the server after eight hours.

## Playwright container sandbox profile

`cloud/seccomp_profile.json` is copied unchanged from [Microsoft Playwright v1.63.0](https://github.com/microsoft/playwright/blob/v1.63.0/utils/docker/seccomp_profile.json), under the Apache License, Version 2.0. Copyright Microsoft Corporation. Playwright identifies it as the Docker default profile extended with user namespace permissions. The Apache-2.0 license text is included in [cloud/THIRD_PARTY_NOTICES.md](cloud/THIRD_PARTY_NOTICES.md). The Playwright package and Docker image retain their upstream notices and licenses.
