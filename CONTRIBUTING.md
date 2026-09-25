# Contributing

> **Draft for review**, written with the first public release; the process will follow what
> the first contributors need.

The platform — the daemon, the desktop app, the launcher, the protocol package, the views —
is open under the Apache License 2.0 and takes contributions. The brain is a separate, closed
package in its own repository and is not part of this tree.

## Before you start

- Read [`docs/architecture.md`](docs/architecture.md): the design is deliberate and the
  docs are kept true as the code changes, so a change that departs from them should change
  them too, in the same pull request, with no history of what used to be there.
- Open an issue for anything beyond a fix, so the shape is agreed before the work.
- Every contribution is accepted under [CLA.md](CLA.md): sign your commits (`git commit -s`)
  or say in the pull request that you agree.

## Working on it

```
git clone --recursive https://github.com/cophyla/cophyla.git
bun install
bun test               # every package; the daemon tests run against a temporary home and never touch ~/.cophyla
bun run typecheck
bun run cophylad       # the daemon on ~/.cophyla
bun run ui             # the desktop app (Rust and WebView2 needed; see apps/ui/README.md)
```

Tests come with the change: the protocol has fixtures per schema, the daemon has a suite per
module over fakes (`apps/cophylad/test/fakes`), the shell checks its command manifest and host
page. `apps/installer/README.md` has the release recipe, which contributors do not need: a
release is signed with a key that stays with the maintainer, and the feed is published from
here.

## Style

Code reads like the code around it: one comment block at the top of a file saying what it is
and why, sentences in the docs, no history in either. The protocol package is the boundary
every process shares; a new field is optional and gets a fixture. The daemon never trusts the
brain: every request from it crosses the gate and lands in the audit.

## Security

A vulnerability in the platform, the updater in particular, goes to the maintainer privately
(the address on the GitHub profile), not to a public issue; you will hear back within a week.
