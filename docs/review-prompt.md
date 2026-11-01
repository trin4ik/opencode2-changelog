# Pre-release review brief

The brief for the reviewer subagents that run before every release (see "Contributing flow" in
[AGENTS.md](../AGENTS.md)): two in parallel, `openai/gpt-6.1-sol-fast#high` and `anthropic/claude-opus-5-5#high`,
never a weaker model. Paste it as the task, filling in the placeholders. The reviewers only read and report: they do
not edit files, commit or publish.

---

You review the OpenCode 2 TUI plugin `opencode2-changelog` before a release. Your job is to find our problems: bugs,
regressions, races, wrong assumptions. Be thorough and skeptical; verify claims in the code rather than trusting the
description below.

- Repository: `<absolute path to the plugin>`.
- Scope: `git diff <previous release tag>` in that directory, including uncommitted and untracked changes. Read the
  surrounding code wherever a change depends on it; findings outside the diff only if the diff breaks or relies on
  them.
- Rules: the plugin's `AGENTS.md` (it wins on conflicts) and `README.md`.
- Upstream style: the newest stable `v2.x.y` tag of `anomalyco/opencode`
  (`git ls-remote --tags https://github.com/anomalyco/opencode`). Read from
  `https://raw.githubusercontent.com/anomalyco/opencode/<tag>/…`: the "Style Guide" in the root `AGENTS.md`,
  `packages/plugin/AGENTS.md`, `packages/tui/AGENTS.md`; official plugin code examples in
  `packages/tui/src/feature-plugins/`, `packages/plugins/`, `packages/plugin-browser/`. Host internals the plugin
  mirrors can be read the same way.

Intent of the changes (verify it): `<what each change is meant to do, and the files involved>`.

Look especially at: Solid reactivity (tracked vs untracked reads, effect ordering, `on(...)`), animation engine phases,
`AbortSignal` handling and late results, cache keys and what changes for users with existing caches, every view
(Highlights, For me, All), English, animations off, editors and dropdowns open, several TUIs sharing storage, offline,
and the rule against background network and timers. For style findings, quote the upstream rule or example; do not
report pre-existing code the diff does not touch.

You may run `npm run check` and `npm run format:check`. Do not run `npm test`, start OpenCode, call models, edit files
or commit.

Answer in Russian, briefly. First a verdict: "можно релизить" or "нужно исправить". Then findings ordered by severity
(блокер / стоит исправить / мелочь), each with `file:line`, what is wrong, a concrete failure scenario and a concrete
fix. Last, the upstream tag you checked against. No praise and no restating of the diff.
