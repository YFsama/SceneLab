# Error Reporting in SceneLab

How errors are captured, surfaced, and — only ever at the user's explicit
request — turned into a bug report. This document records the options that
were considered and why the current "user-initiated copy / save / open
prefilled issue" flow is the right MVP for a **private-repository,
no-backend, offline-first** desktop app.

## Constraints (the premises)

| Premise | Consequence for error reporting |
| --- | --- |
| The GitHub repository is **private** | No public issue tracker for anonymous users; reporters must have access, so the flow targets the developer/maintainer circle |
| **No backend** of any kind | Anything that phones home (Sentry SaaS, telemetry, crash dumps) is out |
| **Offline-first** (Tauri desktop) | Reporting must work with no network until the single final "open GitHub" step |
| Local model data may be confidential | Reports must never contain geometry/project content, only metadata |

## Options considered

### 1. GitHub prefilled-issue link (chosen MVP)

The app builds a plain-text diagnostics report and the user actively chooses
one of: **copy to clipboard**, **save as `.txt`** (native save dialog on
Tauri, browser download on the web), or **open the GitHub "new issue" page
with title+body prefilled** (`src/lib/feedback.ts` → `buildIssueUrl`).

- Pros: zero infrastructure; zero privacy surface (nothing is transmitted
  until the user submits an issue themselves); works offline up to the final
  step; the report content is fully visible to the user before it leaves.
- Cons: no automatic aggregation/dedup; report quality depends on the user;
  GitHub caps the issue body query param (~6 KB) so the report is truncated
  via `truncateForIssue(text, 5000)`.

### 2. Email reports

A `mailto:` link with the report in the body.

- Pros: zero infrastructure, works for users without GitHub access.
- Cons: mailto length limits are unreliable across clients (often ~2 KB),
  most desktop users don't have a mailto handler configured, and it still
  requires the reporter to be in the maintainer circle. Rejected for the
  MVP; can be added later as a second `openFeedback` target if a public
  audience appears.

### 3. Self-hosted Sentry / GlitchTip

GlitchTip (open-source, MIT, Sentry-protocol compatible) can run on a single
small VPS or even a home server; the client would be `@sentry/browser` (or
`sentry-tauri`) pointed at the self-hosted DSN.

- Pros: real crash aggregation, breadcrumbs, release correlation — the
  maintainers' feedback loop improves dramatically once volume grows.
- Cons: violates "no backend" *today*; introduces a privacy review
  obligation (IP logging, PII scrubbing, TLS); needs an operator.

### 4. `tauri-plugin-log` (Rust-side file logging)

Tauri's official log plugin writes log lines to stdout/WebVIEW console and a
rolling file (`~/.local/share/.../logs`), with Rust and JS frontends.

- Pros: captures errors that never reach the webview (Rust command
  panics/errors); the log file is a natural "attach this file" artifact for
  issues; fully offline.
- Cons: alone it solves *storage*, not *reporting* — users don't know the
  file exists. Worth adding as a complement (see upgrade path), not as the
  user-facing flow.

### 5. Fully offline export only

The current save-report button already covers this; a "bundle diagnostics"
zip (report + settings + log file) could follow the same path.

- Pros: maximally private.
- Cons: the extra manual step (user must attach the file somewhere) loses
  most reports. The prefilled-issue link keeps one-click friction while
  staying equally silent until the user acts.

## The MVP (implemented)

**Nothing is ever auto-sent.** The complete flow:

1. **Capture** — `src/lib/errorLog.ts`:
   - `installGlobalErrorCapture()` hooks `window.onerror` (ErrorEvent with
     stack vs. plain string) and `unhandledrejection` (reason normalized:
     `Error` / `string` / arbitrary JSON-able value).
   - `ErrorBoundary` records React render/lifecycle throws with the first
     component-stack frame as `source`.
   - Entries live in an in-memory ring buffer (100) and the newest 30 are
     persisted to `localStorage` (`scenelab.errorlog`), surviving a
     crash→reload loop — exactly when the previous session's errors matter.
2. **Surface** — error toasts get a copy button (`ToastHost`); a full crash
   shows the `ErrorBoundary` fallback card with reload / copy report / try
   to continue.
3. **Report** — `DiagnosticsDialog` (event `scenelab:open-diagnostics`,
   exported `openDiagnostics()`): environment info, recent errors with
   per-entry copy, recent command chips, and four explicit actions —
   copy report / save report / open feedback page / clear log.

### What the report contains (privacy inventory)

```
SceneLab diagnostics
Version: <app version>
Generated: <ISO timestamp>
Platform: <web|windows|macos|linux> (<sniffed OS>)
User agent: <navigator.userAgent>          ← may embed OS/browser build
Locale: <en|zh>
Theme: <dark|light|high-contrast>
Viewport: <innerWidth>x<innerHeight>@<devicePixelRatio>
Recent commands:                           ← command LABELS only, no arguments,
- <up to 8 labels>                            e.g. "Extrude", "Save project"
Recent errors (up to 20):
[ISO] kind: message / stack / source        ← whatever the JS runtime printed
```

Notably **absent**: file paths beyond a stack frame, model/geometry data,
project names, clipboard contents, network information, any unique device or
user identifier. Stacks can contain local file paths in dev builds — worth
knowing before pasting a report into a public venue.

## Upgrade paths

- **Repository goes public** → add `.github/ISSUE_TEMPLATE/bug_report.yml`
  with fields for version/platform/repro, and point `FEEDBACK_PAGE_URL`
  (single constant in `src/lib/feedback.ts`) at
  `issues/new?template=bug_report.yml`. The prefilled title/body flow keeps
  working; the dialog's hint text (`errlog.reportHint`) should then
  explicitly summarize what the report contains (it already does).
- **Willing to self-host** → deploy GlitchTip (single container + Postgres),
  then integrate at one point: `src/lib/errorLog.ts` already funnels every
  capture through `recordError()` — add an optional, **opt-in** (settings
  toggle) `sendToGlitchTip()` call there with `@sentry/browser` +
  `TAURI_UPLOAD_URL` forwarding. Keep auto-send OFF by default to preserve
  the offline-first promise; the DSN lives in config, not code.
- **Rust-side visibility** → add `tauri-plugin-log` in `src-tauri` and mirror
  `recordError()` calls to it; the diagnostics dialog's "save report" can
  then append the rolling log's tail, giving reports native-side context
  (`callNative('save_text_file', …)` already round-trips the artifact).

## 中文小结

SceneLab 是私有仓库、无后端、离线优先的桌面应用，因此错误上报采用
「用户主动」模式：全局错误（window error / unhandledrejection / React
边界）进入本地环形日志（内存 100 条，localStorage 持久化最近 30 条，
崩溃重载后仍可见）；诊断对话框展示环境信息、最近错误与最近命令，
提供「复制报告 / 保存报告 / 打开预填 issue 页 / 清空」四个动作。
报告只含版本、平台、语言主题、视口、命令标签和错误堆栈，
绝不含模型数据，也绝不自动发送。未来若仓库转公开，改一个
`FEEDBACK_PAGE_URL` 常量并加 issue 模板即可；若愿意自托管，
GlitchTip 的接入点是 `errorLog.ts` 的 `recordError()`（需默认关闭、
设置里显式开启）。
