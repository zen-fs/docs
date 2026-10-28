---
title: Testing
description: How to test ZenFS
---

`@zenfs/devel` includes the test suite `@zenfs/core` uses on itself, along with the `zenfs-test` script.
Any package that provides a backend can then run the entire `fs` conformance suite.
This is how every `@zenfs` package tests, and it is the fastest way to find out whether a backend you have written actually works.

## Running the tests

`zenfs-test` is a binary exposed by `@zenfs/devel`,
so it is available through `npx` once you install it as a dev dependency:

```sh
npm install --save-dev @zenfs/devel
npx zenfs-test -ac
```

It takes setup files as positional arguments.
A setup file configures ZenFS with the backend under test and populates it;
the runner then runs the shared suite against whatever that setup left mounted.

```sh
npx zenfs-test tests/setup-idb.ts   # one specific setup
npx zenfs-test -a                   # every setup it can find
```

Tests run with plain `node`, so setup files can only use [erasable](https://nodejs.org/api/typescript.html#type-stripping) TypeScript syntax,
and their imports have to point at files that exist, like your package's build output rather than its `.ts` sources.

`-a`/`--auto` discovers setup files matching `**/tests/setup/*.ts` and `**/tests/setup-*.ts`.
A setup file whose name starts with `_` is skipped during auto-detection.

`-c`/`--common` additionally runs the tests that aren't tied to any backend.

### Notable options

| Flag                   | Description                                                     |
| ---------------------- | --------------------------------------------------------------- |
| `-a`, `--auto`         | Auto-detect setup files.                                        |
| `-c`, `--common`       | Also run the backend-independent tests.                         |
| `-t`, `--test`         | Only run matching suites from `tests/fs`, e.g. `-t 'read*'`.    |
| `-s`, `--skip`         | Skip tests whose names match a pattern. Repeatable.             |
| `-f`, `--force`        | Pass `--test-force-exit`, for backends that leave handles open. |
| `-e`, `--exit-on-fail` | Stop at the first failing suite.                                |
| `-b`, `--build`        | Run the package's `build` script first.                         |
| `-v`, `--verbose`      | Show the runner's output instead of only pass/fail.             |
| `-I`, `--inspect`      | Attach the inspector, for debugging a failing test.             |
| `-h`, `--help`         | The full list.                                                  |

## Writing a setup file

A setup file configures ZenFS and copies in the shared
fixture data, which `@zenfs/devel` exports from `@zenfs/devel/tests/setup`:

```ts
import { configureSingle } from '@zenfs/core';
import { copyAsync, data } from '@zenfs/devel/tests/setup';
import { Duck } from 'duck-backends';

await configureSingle({ backend: Duck });
await copyAsync(data);
```

`data` is the path to the fixture directory;
`copyAsync` (or `copySync`, for synchronous backends) copies it into the root of the virtual filesystem.
The suite assumes that content is present.

If your backend needs tearing down, you can use `node:test`'s hooks in the same file:

```ts
import { after } from 'node:test';

after(() => {
	// close connections, delete the database, and so on
});
```

A setup can also export `fs` to run the suite against something other than the global filesystem, like a bound context:

```ts
import { bindContext, mkdirSync } from '@zenfs/core';
import { copySync, data } from '@zenfs/devel/tests/setup';

mkdirSync('/new_root');

export const fs = bindContext({ root: '/new_root' }).fs;

copySync(data, fs);
```

## Test flags

Not every backend can do everything.
A read-only archive has no writes, the File System Access API has no hard links,
and a backend still being built may simply not have that feature implemented yet.
A setup can declare what its backend supports, and the suite skips exactly the tests that need something missing.

Export `flags` from the setup file:

```ts
import type { TestFlag, TestFlagState } from '@zenfs/devel/tests/common';

export const flags: Partial<Record<TestFlag, TestFlagState>> = {
	links: false,
};
```

Anything not listed is assumed supported, so a setup only names its exceptions.
Accepted values are `true` (default), `false` (skipped as "not supported"),
`'skip'` (skipped as "temporarily skipped"), and `'todo'`.

| Flag              | Test needs to...                                         |
| ----------------- | -------------------------------------------------------- |
| `sync`            | Use synchronous `node:fs` API (e.g. `readFileSync`)      |
| `async`           | Use callback or promises API                             |
| `write`           | Modify anything. Read-only backends set this to `false`. |
| `appends`         | Open files in append mode.                               |
| `directories`     | Create, read, or remove directories.                     |
| `links`           | Create hard links.                                       |
| `symlinks`        | Create or follow symbolic links.                         |
| `rename`          | Rename or move.                                          |
| `truncate`        | Truncate a file.                                         |
| `streams`         | Use read/write streams.                                  |
| `watch`           | Use `fs.watch`.                                          |
| `permissions`     | Depend on mode bits being enforced.                      |
| `xattr`           | Use extended attributes.                                 |
| `times`           | Depend on atime/mtime/ctime being stored and updated.    |
| `tempdir`         | Use the temporary directory.                             |
| `lchmod`          | Use `lchmod`.                                            |
| `promises.exists` | Use the non-standard `exists` from the promises API.     |
| `root`            | Change the global credentials.                           |

Tests opt in with `config`, which returns the `skip`/`todo` options used by `node:test`.
Pass every flag the test depends on:

```ts
import { config, fs } from '@zenfs/devel/tests/common';
import { suite, test } from 'node:test';

suite('Appends', config('appends'), () => {
	test('add content to an empty file', config('async'), async () => {
		// ...
	});
});
```

## Coverage

Coverage is collected by default into `tests/.coverage`, and reported with `c8`:

```sh
npx zenfs-test -ac --report      # run and report
npx zenfs-test --report-only     # report from data already collected
npx zenfs-test --clean           # discard collected data
npx zenfs-test -ac -p            # run, keep the data, don't report
```

`-p`/`--preserve` is helpful when you run several invocations that should be reported together.
Each run clears the coverage directory unless it is set,
so a CI workflow that runs each setup as its own step can use `-p` on every step and `--report-only` at the end.
A single run that covers everything only needs `--report`.

## Performance

The runner has two facilities for performance work.

`-r`/`--runs` runs each suite N times and prints the average,
which can be used to test for flakiness and test time variability:

```sh
npx zenfs-test -ac -r 10
```

`--profile` records a V8 CPU profile per suite into `.profiles/`,
which can be opened in something like Chrome DevTools or VS Code:

```sh
npx zenfs-test -a --profile
```

## Continuous integration

`-C`/`--ci` reports each suite through the GitHub Checks API instead of just printing,
so individual suites show up as separate checks.
It cannot be combined with `-r`.
