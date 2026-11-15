# Code hosting data: sources, licences, attribution

## Where the data comes from

`base.db` is extracted, without additions, from the **WebArena GitLab** image
(`gitlab-populated-final-port8023.tar`, GitLab CE 15.7.5 Omnibus), the code-hosting site of
the WebArena benchmark:

> Shuyan Zhou, Frank F. Xu, Hao Zhu, Xuhui Zhou, Robert Lo, Abishek Sridhar, Xianyi Cheng,
> Tianyue Ou, Yonatan Bisk, Daniel Fried, Uri Alon, Graham Neubig. *WebArena: A Realistic Web
> Environment for Building Autonomous Agents.* ICLR 2024. https://webarena.dev/ --
> code: https://github.com/web-arena-x/webarena (Apache-2.0).

The WebArena authors populated that GitLab by importing **public GitHub repositories**
(source code with full git history, plus their issues, pull requests -> merge requests,
comments, labels, milestones and contributors as GitLab users), and added a few small
repositories and activity of their own (the `byteblaze`, `convexegg`, `yjlou`, `root`
projects and the task user `byteblaze`). In this extraction:

- users, namespaces, projects, members, stars, follows, labels, milestones, issues, merge
  requests (+ latest diff, commits, reviewers, approvals), notes, events, to-dos and resource
  events come from the image's PostgreSQL database;
- git commits, refs, trees and blobs come from the image's bare repositories (trees/blobs of
  older commits of large repositories and large binaries are omitted, see SCHEMA.md);
- project templates are GitLab's built-in templates shipped in the image
  (`vendor/project_templates`, from https://gitlab.com/gitlab-org/project-templates and
  https://gitlab.com/pages, each under its own licence, mostly MIT);
- nothing was added. Secrets were dropped (all access tokens, SSH keys, OAuth/CI/runner
  tokens, OTP secrets, webhooks); the only token kept is byteblaze's RSS feed token, which a
  WebArena task asks for and which is published in the WebArena task file.
- Redactions (`build/redact.py`): live-looking credentials pasted into imported issue/MR
  descriptions and comments (GitHub tokens, Google API keys, AWS access key ids / secret keys,
  Slack tokens, PEM private key bodies) are replaced with `[REDACTED]` (14 cells), and the 9
  personal webmail addresses in `users.email` are replaced with `<username>@example.com` (no
  task uses them). Git data (commit/tag author and committer emails, blobs, commit messages)
  is left as recorded in the public repositories.

## Licences

- **Repository contents** (files, commit messages, author names/emails as recorded in git)
  are the work of each upstream project's contributors, under **each repository's own
  licence**. The list of all 175 projects with their GitHub upstream and the licence file
  found at the root of the default branch is generated into
  [`SOURCES.repos.md`](SOURCES.repos.md) by `build/licenses.py`. Repositories without a
  licence file ("none found") are mirrored by WebArena as public GitHub repositories; no
  licence is granted beyond that -- redistribute them only as part of this research
  benchmark with attribution, or drop them.
- **Issues, merge requests and comments** were written by GitHub users on the upstream
  projects and imported by WebArena; they are public GitHub content (GitHub Terms of
  Service), attributed by author username in the data.
- **The WebArena-created content** (byteblaze etc.) comes with the WebArena release
  (Apache-2.0 code; data released for research).
- **GitLab templates**: see each template's LICENSE in its tree (`project_templates`).

## Attribution text (for the dataset card)

> The code-hosting data is derived from the WebArena GitLab environment (Zhou et al., 2024,
> https://webarena.dev), which mirrors public GitHub repositories together with their
> issues, pull requests and comments. Each repository remains under its own licence (see
> SOURCES.repos.md); issue and comment text belongs to its GitHub authors. Project templates
> are from GitLab (https://gitlab.com/gitlab-org/project-templates).
