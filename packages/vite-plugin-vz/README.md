# vite-plugin-vz

Upload complete Rolldown build diagnostics to a VZ platform using GitHub Actions OIDC.

```ts
import { defineConfig } from "vite";
import vz from "vite-plugin-vz";

export default defineConfig({
  plugins: [
    vz({
      endpoint: "https://your-platform.example",
      project: "web",
      enabled: process.env.UPLOAD_DIAGNOSTICS !== "false",
    }),
  ],
});
```

`endpoint` is required and must use HTTPS. `project` defaults to the app root relative
to the Git checkout. `enabled` defaults to `true`; `strict` defaults to `false`.
Upload errors warn without failing the application build unless `strict` is enabled.

Install the platform's GitHub App on the repository and grant the workflow:

```yaml
permissions:
  contents: read
  id-token: write
```

Uploads run after a successful build, with one report per built environment.
Outside GitHub Actions, the plugin performs no capture or network requests.
Without OIDC permissions it skips collection and prints setup instructions.

Full diagnostics include source and transformations. Public repository reports,
including their source and raw data, are publicly readable. Private reports require
current GitHub repository access. Capture adds profiling and upload time to CI.

The initial native-format adapter supports Rolldown 1.2.x, including the 1.2.18
bundled with Vite+ 1.6.0. An unsupported version warns (or fails in strict mode).
Use Vite 8.3+ or Vite+; older Rollup-based Vite versions are unsupported.

Build this package with `vp run --filter vite-plugin-vz pack`. Its distribution is
ESM with type declarations and bundles the private protocol workspace package.
The package has not been published by this implementation. For local consumption,
run `vp -C packages/vite-plugin-vz pm pack --pack-destination /tmp` and install that tarball.

## Captured data

The default capture uploads:

- The complete compressed native JSONL log and native session metadata, including
  events that this adapter does not yet recognize.
- Static/dynamic module graphs, importers, entry points, side effects, exports,
  transformed source, rendered module code/exports/lengths, and per-hook before/after
  source with resolution inputs/results and timing details.
- Chunk graphs, exports, entry/facade modules, CSS and asset dependencies, package
  versions/roots/dependency types/usage, and duplicate package versions.
- Every emitted bundle file (JavaScript, CSS, HTML, binary assets, manifests, etc.)
  and generated source maps, stored losslessly with gzip compression. Source maps
  are collected when the build generates them; capture does not change that setting.
- A compressed Vite output snapshot per output format containing the module/chunk/file
  inventory, plugin names/order, allowlisted build settings, and Node/platform versions.
- Build warnings, memory usage, and process CPU usage in `build-context.json.gz`.

Environment variables, `define` values, and arbitrary plugin configuration are not
serialized into the configuration snapshot. Source code, emitted files, native logs,
warning frames, and generated maps are still complete build diagnostics and can
contain values that your application intentionally embeds during compilation.

Large normalized records are stored as compressed JSON sidecars and linked from
bounded dataset pages. Nothing is truncated to fit a page. The report's **Captured
files** section exposes output files, maps, snapshots, and full-record downloads.
The normal multipart, checksum, authorization, and retention rules apply to all files.
