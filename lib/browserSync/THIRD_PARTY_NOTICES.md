# Browser platform adapter notices

## baoyu-skills — MIT

WeChat image-post editor selectors and the image-input/draft-button workflow in
`platforms.mjs` are adapted from Jim Liu's baoyu-skills, commit
`8ae8c33a8d7c8c7c6de291b2c91ba1debe1d2766`:

- [wechat-browser.ts](https://github.com/JimLiu/baoyu-skills/blob/8ae8c33a8d7c8c7c6de291b2c91ba1debe1d2766/skills/baoyu-post-to-wechat/scripts/wechat-browser.ts)
- [wechat-agent-browser.ts](https://github.com/JimLiu/baoyu-skills/blob/8ae8c33a8d7c8c7c6de291b2c91ba1debe1d2766/skills/baoyu-post-to-wechat/scripts/wechat-agent-browser.ts)

Modified 2026-09-10: removed local processes, CDP and filesystem access; use
in-memory images inside an existing page; require an empty, unambiguous native
image editor; upload sequentially; preserve text; only trigger explicitly labeled
draft buttons; report unverified saves as needing confirmation.

```text
MIT License

Copyright (c) 2026 Jim Liu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## OpenCLI — Apache-2.0

Xiaohongshu image-editor selectors are adapted from [jackwener/OpenCLI](https://github.com/jackwener/OpenCLI/blob/8271afc67e8504bda94c147f446ee29775d08274/clis/xiaohongshu/publish.js),
commit `8271afc67e8504bda94c147f446ee29775d08274`.

Copyright 2025 jackwener. Licensed under Apache License 2.0. The complete upstream
license is included in [LICENSE-APACHE-2.0.txt](./LICENSE-APACHE-2.0.txt). The upstream
tree at this commit does not contain a NOTICE file.

Include this notice (including the MIT license above) and the complete
LICENSE-APACHE-2.0.txt when distributing the script, including in bundled builds.

Modified 2026-09-10: retained only image-editor selectors; removed network account
lookup, browser management and private component-method invocation; only an exact
visible draft-button label can trigger a save.
