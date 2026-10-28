---
title: Writing a backend
description: How to implement a backend for ZenFS.
---

A backend is a `FileSystem` implementation that does the actual work, plus a `Backend` object that describes how to configure and construct it.
The `Backend` object is the part users interact with and it is what gets passed to `configure`.

## Where to start

Most backends shouldn't implement `FileSystem` at all. Pick the highest-level abstraction that fits whatever you are wrapping:

| What you have                                                                                          | What to use                             |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| Somewhere to put bytes under a numeric key (`localStorage`, IndexedDB, an `ArrayBuffer`, a KV service) | Implement `Store`, pass it to `StoreFS` |
| A directory structure you can enumerate up front (an archive, an HTTP index)                           | Extend `IndexFS`                        |
| Something with its own path-based semantics (another `fs`, a remote API with paths)                    | Extend `FileSystem`                     |

The first case covers most backends. `StoreFS` implements inodes, directory listings, hard links, and transaction rollback on top of a key-value store, which means a store is usually a few dozen lines.

## Stores

A `Store` needs a name, a way to sync, and a way to begin a transaction. If your storage is synchronous and shaped like a `Map`, implement `SyncMapStore` and use `SyncMapTransaction`. That is all `InMemory` is:

```ts
import { StoreFS, SyncMapTransaction, type SyncMapStore } from '@zenfs/core';

export class ExampleStore extends Map<number, Uint8Array> implements SyncMapStore {
	/** The name of the file system type, like `tmpfs` for `InMemory` */
	public readonly name = 'examplefs';

	public async sync(): Promise<void> {}

	public transaction(): SyncMapTransaction {
		return new SyncMapTransaction(this);
	}
}
```

Keys are allocated by `StoreFS` and should be treated as opaque. An inode and its data live under different keys, so don't assume the set of keys maps to the set of files. `StoreFS` creates the root directory itself once the file system is ready, so a new store starts out empty and valid.

A couple of optional members are worth setting:

- `type` is a unique 32-bit id for the kind of file system. The convention is four ASCII characters, e.g. `0x6b766673` for `kvfs`. It isn't used internally yet.
- `label` names the instance rather than the type, the same way partition labels do. A share name or database name is a good choice.
- `flags` is for optimizations. Set `'partial'` if your store can read and write ranges rather than whole values, since `StoreFS` will then avoid round-tripping entire files.

### Asynchronous stores

If your storage is async, extend `AsyncTransaction` instead. It implements the synchronous methods against a cache and throws `EAGAIN` when the data isn't cached, so anything you want to work synchronously has to be loaded ahead of time. `@zenfs/dom`'s IndexedDB store preloads every record when the backend is created:

```ts
async create(options: IndexedDBOptions & Partial<SharedConfig>) {
	const store = new IndexedDBStore(await createDB(options.storeName || 'zenfs', options.idbFactory));
	const fs = new StoreFS(store);
	if (options.disableAsyncCache) return fs;
	await store.transaction().preload();
	return fs;
}
```

Honoring `disableAsyncCache` like this is worth doing. It is part of `SharedConfig`, so users can already set it on any mount, and it sets the `no_async_preload` attribute for you; all your backend needs to do is skip the preload.

## The backend object

The backend describes its options, then creates the file system:

```ts
import type { Backend } from '@zenfs/core';

export interface ExampleOptions {
	raw: RawExampleData;
}

const _Example = {
	name: 'Example',
	options: {
		raw: { type: 'object', required: true },
	},
	isAvailable() {
		return 'exampleStorage' in globalThis;
	},
	create({ raw }: ExampleOptions) {
		return new StoreFS(new ExampleStore(raw));
	},
} as const satisfies Backend<StoreFS<ExampleStore>, ExampleOptions>;
type _Example = typeof _Example;
export interface Example extends _Example {}
export const Example: Example = _Example;
```

`options` is checked before `create` is called, so you can assume everything required is present and of the right type. The `type` of an option can be a `typeof` string, a class name, a class, or a predicate.

`isAvailable` should check whether the environment supports the backend at all, for example a browser API existing. It should not check whether this particular configuration will work.

The `as const satisfies` and interface stuff at the end exists to keep error messages readable when someone misconfigures the backend. [Backends](/core/backends/) covers why in detail.

Note that `create` and `isAvailable` returning promises means your backend can only be used with `configure`, not `configureSync`, which throws `EAGAIN` rather than blocking.

## Implementing `FileSystem` directly

If neither `StoreFS` nor `IndexFS` fits, you can extend `FileSystem`. Every path you are given is absolute and every argument is present, so there is no normalization to do.

Each operation has a sync and an async version. Implementing both is ideal, though you rarely have to write both by hand:

- `Sync(FileSystem)` implements the async methods using the sync ones.
- `Async(FileSystem)` implements the sync methods by running them against an in-memory copy and pipelining the real work. Set `_sync` to the file system used as the cache, usually `InMemory.create({ label: '...' })`.
- `Readonly(FileSystem)` implements every mutating method to throw `EROFS`, and sets the `no_write` attribute.

They compose with anything, including `IndexFS`. For example, `@zenfs/dom`'s File System Access backend is `class WebAccessFS extends Async(IndexFS)`.

There are a few things the VFS expects that aren't obvious from the type signatures:

- **`stat('/')` must work**. The VFS assumes the root exists.
- **`ino` must be unique within the file system.** It is what identifies a file, so using the same one for multiple files puts them all on the same vnode and they'll appear to share content.
- **Symlinks aren't special.** The VFS creates a regular file, writes the target into it, then changes the mode to `S_IFLNK`. If you preserve modes and file contents you support symlinks.
- **Metadata comes back through `touch`.** `stat` returns an `InodeLike`, and any change to it — mode, times, ownership, size — arrives as a `touch` call with a partial inode to merge in.

`attributes` controls how the VFS treats the file system. `no_write` for read-only backends, `no_atime` if you can't cheaply update access times, `sync` if writes are always durable immediately. These are analogous to options in [/etc/fstab](https://en.wikipedia.org/wiki/Fstab).

## Errors

ZenFS uses [kerium](https://www.npmjs.com/package/kerium) for errors. Throw `withErrno` with the code the equivalent syscall would use:

```ts
import { withErrno } from 'kerium';

if (!this.entries.has(path)) throw withErrno('ENOENT');
```

The VFS handles the common cases before calling your `FileSystem` methods: `EISDIR`, `ENOTDIR`, and `EEXIST` on `open` are checked against `stat`.

Mostly you should need `ENOENT` when something is missing, `EEXIST` when creating over something that exists, `ENOTEMPTY` from `rmdir`, and `ENOSPC` when you run out of room. Converting errors from the underlying storage is your job; a `try`/`catch` that maps native error codes onto errno values is typical.

## Testing

`@zenfs/devel` has the test suite every `@zenfs` package uses, so you can run the entire `fs` conformance suite against your backend. Install it as a dev dependency, then write a setup file that configures your backend and copies in the fixture data:

```ts
import { configureSingle } from '@zenfs/core';
import { copyAsync, data } from '@zenfs/devel/tests/setup';
import { Example } from '../dist/index.js';

await configureSingle({ backend: Example, raw: /* ... */ });
await copyAsync(data);
```

```sh
npx zenfs-test -abc
```

If your backend can't do everything (e.g. no hard links, no writes, no atime) export `flags` from the setup file and the suite will skip exactly the tests that need what's missing, instead of you filtering by name. See [Testing](/core/testing/) for the full list of flags and options.

:::note
A backend is not a derivative work of ZenFS. Importing `@zenfs/core` and implementing its interfaces does not put your code under the LGPL, so you can license a backend however you want.
:::
