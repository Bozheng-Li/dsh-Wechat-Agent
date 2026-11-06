# Third-party notices

DSH Wechat Agent is distributed under AGPL-3.0-or-later. Its license does not replace the licenses of dependencies or proprietary components.

## Project source

The plugin and the protocol/login subset in `src/wechat/` and `runtime/` originate from [Wechat Agent](https://github.com/2720480371/wechat-agent). This standalone repository preserves that project's AGPL-3.0-or-later license. Protocol, persistence and login behavior are retained; imports and build paths have been adapted for the standalone layout.

## JavaScript dependencies

The plugin bundles fast-xml-parser, Zod and their included dependencies. Full dependency licenses are copied into `licenses/` in the complete installation package. Exact versions, integrity hashes and the development toolchain are locked in `package-lock.json`.

React is provided by DeepSeek Harness and is not bundled by this project. Rolldown and node-tar are build tools. DeepSeek Harness is installed separately and remains subject to its own license and terms.

## Python runtime

The complete Windows package includes the official Python 3.13.9 embedded distribution with its original license. Python dependencies are pinned in `runtime/requirements.txt`; their distribution metadata and license files remain in the packaged `site-packages` directory. These include cryptography (Apache-2.0/BSD), Pillow (HPND), Frida (wxWindows Library Licence 3.1), CFFI (MIT) and pycparser (BSD).

## WeChat runtime

Complete local packages use selected operator-provided Tencent WeChat 3.9.12.51 binaries that match the project's verified runtime. Tencent retains ownership of those proprietary binaries; AGPL does not license them. They are excluded from this source repository. The local `runtime/wechat39-engine/manifest.json` records file sizes and SHA-256 hashes. The build excludes the portable wrapper, miniapp/OCR/video-player bundles and user data.

Public protocol field layouts from [wechat7016](https://github.com/ByboyCn/wechat7016) served as a research reference. No upstream C# source is distributed. This repository does not grant rights to Tencent's products or marks.

This project is not affiliated with DeepSeek or Tencent. Their names identify interoperability targets, not endorsements.
