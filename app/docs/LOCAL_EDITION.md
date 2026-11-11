# Local edition

`NEXT_PUBLIC_EDITION=local` runs the Go Flow editor with **no backend, no MongoDB, no docker**.
All data lives on the client in a `ProjectStore`; the app is exported as static files
(`out/`) and is meant to be wrapped by Tauri (G2b).

```bash
npm run dev:local            # next dev, local edition
npm run build:local-static   # static export to app/out/
python3 -m http.server 4173 --directory out   # or any static server
```

## How it works

| Piece                                                    | Role                                                                                                                                                                                                                                         |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/utils/edition.ts`                                   | `isLocal()`. `isOSS()` is also true for `local` (local = OSS restrictions + no backend), `isAIEnabled()` is false.                                                                                                                         |
| `src/services/api.ts` → `ApiService.fetchWithAuth`       | **Single switch point**: in the local edition every request goes to `LocalApi.fetch()` instead of the network. All `api.*` methods and raw `fetchWithAuth` callers keep working unchanged.                                                    |
| `src/services/local/localApi.ts`                         | In-browser mirror of the backend REST routes and response envelopes (projects, project info, timelines, snapshot, entities/types/parameters, manual localization, images, import). Unknown routes answer `501`.                             |
| `src/services/local/projectStore.ts`                     | `ProjectStore` interface + `IndexedDbProjectStore` (Dexie DB `GoFlowLocalProjects`). `getProjectStore()` is the only factory — G2b returns a Tauri fs store there.                                                                           |
| `src/services/dbService.ts`                              | Graph persistence: `saveProject()` writes the graph through to the project document (`LocalApi.saveGraph`). `addOperation()` does not queue sync operations; it triggers a debounced `saveToDb()` (registered in `useGraphStore`).          |
| Routing                                                  | No dynamic segments: `/project?project=…`, `/project/editor?project=…&timeline=…&layer=…`, `/project/entities?project=…&type=…&entity=…`, `/project/localization?project=…`, `/project/play?project=…&timeline=…`. Builders in `utils/navigation.ts`. |
| `next.config.ts`                                         | `output: 'export'`, `images.unoptimized`, `trailingSlash` for local; `standalone` otherwise. Middleware lives in `src/middleware.mw.ts` and is only picked up (via `pageExtensions`) outside the local edition.                              |

Auth: the single local user (`LOCAL_USER` in `localApi.ts`) is returned by `GET /auth/me`; there is no login screen.

## Project document (one self-contained JSON per project)

This is exactly what `ProjectStore.save()` receives and what G2b writes to
`<projects dir>/<slug>/project.json`. Images are stored next to it (`images/<key>`), not inside the JSON.

```jsonc
{
  "format": 1,                       // bump on breaking changes
  "id": "6f1c…",                     // 24 hex chars (same shape as backend ObjectIds)
  "name": "Bar Night",
  "createdAt": "2026-11-11T06:35:38.630Z",
  "updatedAt": "2026-11-11T06:35:56.866Z",
  "graph": {
    "timelines": {
      "<timelineId>": {
        "layers": { "root": { "type": "layer", "id": "root", "nodeIds": [], "nodes": {}, "edges": {} } },
        "metadata": { "root": { "panelState": {}, "viewport": {} } },
        "variables": [],
        "lastLayerNumber": 0
      }
    },
    "timelinesMetadata": [
      { "id": "<timelineId>", "name": "Main Timeline", "description": "Default timeline", "order": 1, "isActive": true, "createdAt": "…", "updatedAt": "…" }
    ]
  },
  "projectInfo": { "id": "…", "projectId": "…", "logline": null, "synopsis": null, "genres": [], "formats": [], "status": "concept", "…": "…" },
  "entityTypes": [
    { "id": "…", "name": "Character", "type": "character", "description": null, "isDefault": false, "order": 0,
      "parameters": [ { "id": "…", "parameterId": "<paramId>", "required": true, "order": 0 } ] }
  ],
  "entityParameters": [ { "id": "<paramId>", "name": "Age", "valueType": "NUMBER", "options": [], "order": 0 } ],
  "entities": [
    { "id": "…", "name": "Mira", "entityTypeId": "…", "description": null,
      "image": { "type": "image", "storage": "local", "original": { "gcsPath": "<entityId>__entity-avatar" } },
      "values": [ { "id": "…", "parameterId": "<paramId>", "value": 27 } ] }
  ],
  "localization": {
    "config": { "baseLanguage": "en", "targetLanguages": ["ru"], "…": "…" },
    "entries": [
      { "id": "…", "timelineId": "…", "layerId": "root", "nodeId": "…", "nodeType": "narrative", "fieldPath": "data.text",
        "baseLanguage": "en", "targetLanguage": "ru", "originalText": "Rough night?", "translatedText": "Тяжёлая ночь?",
        "status": "TRANSLATED", "method": "MANUAL", "wordCount": 2, "characterCount": 12 }
    ]
  }
}
```

The `graph` part has the same shape as the backend `project.data` snapshot and as the JSON export,
so cloud ⇄ local migration is an export/import away.

Image keys are `<entityId>__<parameterId>`; the `MediaValue` stored in an entity uses
`storage: "local"` and the key as `gcsPath`. Images are served to `<img>` as object URLs.

## Desktop app (Tauri 2)

```bash
npm run tauri:dev     # dev:local + native window
npm run tauri:build   # src-tauri/target/release/goflow-ut + bundle/{appimage,deb}
goflow-ut --godot-project ~/games/useless-tycoon [--project-dir <dir>]
```

- `src-tauri/`: plugins fs and dialog. The webview never passes a program, argv or arbitrary path to Rust:
  folders (Godot project, projects dir, dialogue dir) and the Godot executable are chosen in native dialogs
  opened by Rust (`pick_godot_path`) or come from CLI args, are validated (project.godot present; executable
  file named `*godot*`) and persisted in `<app config>/godot-paths.json` (denied to the webview fs scope).
  `play_in_godot(project, dialogue_res, cue)` validates `res://<path>.dialogue` / `[A-Za-z0-9_]+` and builds the argv.
- fs scope: statically only `$APPDATA/**`; the chosen projects/dialogue folders and the game manifest are added
  at runtime (`fs_scope().allow_directory`) on startup and after each pick. CSP: `default-src 'self'`
  (see `tauri.conf.json`; style-src keeps `'unsafe-inline'` for React inline styles).
- Under Tauri `getProjectStore()` returns `TauriFsProjectStore` (`src/services/local/tauriFsProjectStore.ts`):
  `<projectsDir>/<slug>/project.json` (2-space indent, keys sorted recursively, trailing newline) and
  `<slug>/images/<entityId>__<parameterId>.<ext>`. The slug comes from the project name once; renames keep the folder.
- External changes (git pull, branch switch): every read compares the file mtime with the one this session
  last read/wrote; on window focus all known projects are re-checked. A newer file on disk is never
  overwritten: a toast is shown and the window reloads from disk.
- Settings → **Godot** (`src/services/godot/settings.ts` → Rust commands): Godot project,
  projects dir (default `<godot>/narrative`), dialogue dir (default `<godot>/content/dialogue`), Godot executable,
  auto-export toggle. `--godot-project` / `--project-dir` CLI args override. The game manifest is always
  `<godot>/narrative/game_manifest.json`.
- Export modal → Dialogue Manager → **Write to Godot project**, and auto-export: `exporters/projectDocument.ts`
  on the saved project document (same code as `scripts/export-dialogue.ts`, so output is byte-identical;
  `<godot>/narrative/game_manifest.json` is used when present — pass the same file to the CLI with `--manifest`).
- **Play in Godot** (node context menu, play bar): exports, then runs
  `<godot> --path <godot project> -- --dialogue res://content/dialogue/<file>.dialogue --cue <cue>`;
  the cue comes from `DialogueManagerCodeGenerator.cueNames()`.
- Fonts are bundled (`@fontsource/inter`, `next/font` for Geist): no network needed at runtime.

## Removed / hidden in the local edition

- **AI** (node fill, bible generation, AI entity creation, AI translation, settings/debug): buttons hidden, routes 501.
- **Billing, payments, credits, pricing, usage, teams, members, invites**: hidden by the existing OSS guards; routes 501.
- **Comments, notebook**: hidden (no unread-count polling).
- **WebSocket / realtime collaboration / presence**: not mounted (OSS provider tree).
- **Analytics / Amplitude**: no-op (OSS guard).
- **GCS**: replaced by `ProjectStore` images.
- **Project templates**: none bundled (`GET /project-templates` → `[]`, "No template" only).
- **Bible quality score**: not computed (404 → widget empty).

## Known limitations

- Graph edits are persisted 200 ms after the last operation (debounced full-snapshot save); closing the tab inside that window loses the last edit.
