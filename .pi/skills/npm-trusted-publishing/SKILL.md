---
name: npm-trusted-publishing
description: Publish npm packages through GitHub Actions trusted publishing. Use when preparing npm OIDC, checking whether trusted publishing is active, releasing a version, or babysitting deployment through registry, provenance, and install verification.
---

# npm trusted publishing

Treat publishing as three observable states:

1. **Workflow ready** — repository contains valid OIDC workflow.
2. **Trust confirmed** — npm accepted an OIDC publish from that workflow.
3. **Deployment verified** — expected version, payload, provenance, and install all pass.

State current level explicitly. Workflow presence alone proves only level 1.

## 1. Inspect

Read `package.json`, lockfile, Git remote, status, tags, releases, and `.github/workflows/`. Check npm registry for package and current version.

Verify:

- package name, version, public `publishConfig`, and `repository.url` match target npm package and GitHub repository;
- publish payload declares required runtime files through `files`, `exports`, `main`, or package-specific manifest;
- workflow uses GitHub-hosted runner, `id-token: write`, supported Node/npm versions, clean install, tests/build, release-tag/version check, payload check, and `npm publish`;
- workflow carries no `NPM_TOKEN` for publishing.

Consult current primary npm trusted-publisher docs before creating or changing workflow. Preserve an existing valid trigger; prefer published non-prerelease GitHub releases for new workflows.

**Complete when:** readiness level and every blocker are reported from evidence.

## 2. Establish trust when unconfirmed

For GitHub Actions, give user exact npm package **Settings → Trusted Publisher** values derived from repository:

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | GitHub repository owner |
| Repository | Repository name |
| Workflow filename | Filename only, under `.github/workflows/` |
| Environment | Exact workflow environment, or empty |
| Allowed action | `npm publish` |

If package does not exist, first publication may need one authenticated local bootstrap:

```sh
npm login
npm publish --access public
```

Then configure trusted publisher before next version. Use OIDC for subsequent releases.

**Complete when:** workflow is pushed and user has exact npm settings. Describe trust as “ready, npm-side unconfirmed” until OIDC publish succeeds.

## 3. Release

Publishing is outward-facing. If user has not explicitly requested release, call `ask_user` before push, tag, GitHub release, or npm publish.

From clean, synchronized default branch:

1. Choose an unpublished SemVer version.
2. Update package and lockfile together.
3. Run full checks plus package-payload validation.
4. Commit, create matching `v<version>` tag, push branch and tag.
5. Publish GitHub release to trigger workflow.

Typical commands:

```sh
npm version patch --no-git-tag-version
npm run check
git add package.json package-lock.json <changed-files>
git commit -m "<conventional message>"
git tag v<version>
git push origin <branch>
git push origin v<version>
gh release create v<version> --verify-tag --generate-notes --title "v<version>"
```

Adapt commands to existing release tooling instead of creating competing machinery.

**Complete when:** GitHub release exists and matching publish run has started.

## 4. Babysit to verification

Stay through completion when user asks to publish or babysit:

1. Watch exact run with `gh run watch <id> --exit-status`.
2. Confirm registry version with `npm view <package> version`.
3. Download published tarball in a temporary directory and verify every declared runtime entrypoint exists.
4. Confirm `dist.attestations.provenance` for public GitHub OIDC packages.
5. Smoke-install exact version with package-native installer; verify runtime entrypoint loads or exists.
6. Check repository is clean and tag, release, workflow SHA, and npm version agree.

A successful workflow with OIDC evidence establishes **Trust confirmed**. Passing all six checks establishes **Deployment verified**.

If any check fails, report exact failed layer and publish a new patch version after fixing it; npm versions are immutable.

## 5. Report and harden

Report package/version, commit, tag, release URL, workflow URL, payload entrypoints, provenance, and smoke result. Name broken older versions when relevant.

After first confirmed OIDC release, recommend npm **Publishing access → Require 2FA and disallow tokens**, then revoke obsolete automation tokens.
