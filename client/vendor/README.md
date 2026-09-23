# client/vendor

Third-party code, committed rather than fetched.

Everything the browser loads has to come off this machine — the room is a LAN
with no way out, and a `<script src="https://…">` would leave the board half
drawn on the one evening the office wi-fi cannot reach the internet. So the one
library the client uses lives here, in the repository, at a pinned version.

## three.js

| | |
| --- | --- |
| Version | **0.185.1** |
| Files | `three.module.min.js` (366KB), `three.core.min.js` (385KB) |
| Licence | MIT — `three-LICENSE.txt` |
| Source | `https://registry.npmjs.org/three/-/three-0.185.1.tgz`, `package/build/` |

`three.module.min.js` imports `./three.core.min.js` by relative path, which is
why both files sit here together and neither may be renamed. They are ES modules
the browser loads directly: no bundler, no build step, no transform. The board
imports them from `client/mono3d.js` and nothing else touches them.

Loaded **lazily** — the import happens the first time somebody opens a 3D board,
not on the landing page and never in the word game. A browser that never sits at
a Monopoly table never downloads it.

### Updating

Download the tarball, take the two files out of `package/build/`, take `LICENSE`,
update the version in the table above. Check the board afterwards: three.js
removes deprecated API on a schedule and `client/mono3d.js` is the only thing
that would notice.

```sh
curl -sO https://registry.npmjs.org/three/-/three-<version>.tgz
tar -xzf three-<version>.tgz package/build/three.module.min.js \
  package/build/three.core.min.js package/LICENSE
```

## Not formatted, not linted

`deno.json` excludes this directory from `fmt`. It is somebody else's minified
code and reformatting it would produce a diff nobody can read and a file that no
longer matches the published one.
