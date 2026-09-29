# Extension publisher monorepos

Rel.AI supports one extension repository per developer or organization. Each extension remains independently versioned, permissioned, installed, and updated, but the publisher does not need a separate Git repository for every extension.

## Recommended layout

```text
my-relai-extensions/
  relai-publisher.json
  publisher-catalog.json
  extensions/
    officecli/
      relai-extension.json
      SKILL.md
    android-tools/
      relai-extension.json
      SKILL.md
      references/
        workflows.md
```

The runtime still installs individual extension packages. The monorepo only reduces authoring and publishing overhead.

## Create a publisher repository

Install or run the Rel.AI package CLI and initialize the repository once:

```bash
relai-extension init . \
  --namespace kyne \
  --publisher "Kyne" \
  --publisher-url https://github.com/Kyne0328 \
  --repository https://github.com/Kyne0328/kyne-relai-extensions
```

For GitHub repositories, Rel.AI derives the raw-content base URL from the repository and `main` branch. Use `--branch` or `--raw-base-url` when that does not match the repository.

The namespace becomes the prefix for every extension ID created in that publisher repository. For example, `officecli` becomes `kyne.officecli`. Extension IDs remain globally unique even though many packages share one repository. Initialization preserves any existing `.gitattributes` and appends an `extensions/** text=auto eol=lf` rule when needed so text-package SHA-256 values generated on Windows match normal Git raw-content bytes without changing line-ending policy for the rest of the publisher repository.

## Create extensions

Create as many independently installable packages as needed:

```bash
relai-extension create officecli
relai-extension create android-tools
relai-extension create apktool --kind cli --command apktool
```

Each command creates `extensions/<name>/relai-extension.json` and `SKILL.md`. Skill and CLI packages keep the same v1 manifest format used by the production extension registry.

Standalone extension repositories remain supported. The monorepo layout is the recommended workflow for developers or organizations publishing more than one extension.

## Synchronize hashes and publisher metadata

After adding or editing extension package files, run:

```bash
relai-extension sync
```

Sync performs the repetitive package bookkeeping:

- discovers regular package files under every `extensions/<name>/` directory;
- rejects symlinks;
- refreshes SHA-256 hashes in each extension manifest;
- keeps publisher and repository metadata aligned with `relai-publisher.json`;
- regenerates `publisher-catalog.json`.

Hidden files, `node_modules`, and `relai-extension.json` itself are not included in the install package.

## Validate and test locally

```bash
relai-extension validate
relai-extension dev-install officecli
```

Validation checks every manifest with Rel.AI's production extension schema, verifies the publisher namespace, package file list and hashes, shared publisher metadata, and the generated publisher catalog.

`dev-install` runs `sync` and validation first, then installs the selected extension from the local publisher working tree into Rel.AI's managed extension directory. Local package files must pass the same manifest, size, path, permission, compatibility, and SHA-256 checks as published packages. CLI install artifacts declared by a manifest still use their normal verified HTTPS download path. Run `dev-install` again after changing package files.

This local source path exists only for the explicit developer CLI. Production source discovery still requires HTTPS catalogs and HTTPS manifests/files; local paths and `file:` URLs are not accepted as catalog sources.

## Share a publisher repository

The generated `publisher-catalog.json` is the public discovery document for the repository. After `relai-extension sync` and `relai-extension validate` pass, push the publisher repository to an HTTPS host and share its URL.

For a GitHub repository on the `main` branch, users can open Extensions → Sources and add the normal repository URL, for example:

```text
https://github.com/example/example-relai-extensions
```

Rel.AI resolves that repository to its raw `publisher-catalog.json`, validates the catalog, and makes its extensions available in Discover. For a publisher hosted somewhere other than GitHub, users can add the direct HTTPS URL to `publisher-catalog.json`.

Adding a source does not install or execute its extensions. Installation still requires permission review, manifest/catalog agreement, compatibility checks, safe package paths, and SHA-256 verification. Active sources cannot claim an extension ID already supplied by another active source. Installed extensions are pinned to the catalog that installed them, so another repository cannot take over updates for the same ID.

Removing a source does not uninstall its extensions. The installed package remains available, but Rel.AI stops discovering updates for it until that source is added again.

`REL_AI_EXTENSIONS_CATALOG_URL` remains available as a development override for the built-in catalog when testing unpublished remote changes.

## Optional official catalog publication

The built-in `Kyne0328/rel-ai-extensions` catalog remains the curated default source. A third-party publisher does not need to submit every extension there; users can add the publisher repository directly.

If you want an extension to appear in the built-in catalog without users adding a source, submit its catalog entry to `Kyne0328/rel-ai-extensions` after publishing and validating the extension package.

Production installs continue to require HTTPS package sources, declared permissions, and SHA-256 verification regardless of whether the extension comes from the built-in catalog or an added source.
