# Third-party notices

DSH Wechat Agent is distributed under AGPL-3.0-or-later. Its license does not replace the licenses of dependencies or proprietary components.

## Project source

The plugin and the protocol/login subset in `src/wechat/` and `runtime/` originate from [Wechat Agent](https://github.com/2720480371/wechat-agent). This standalone repository preserves that project's AGPL-3.0-or-later license. Protocol, persistence and login behavior are retained; imports and build paths have been adapted for the standalone layout.

## Built-in sticker artwork

The `assets/stickers/` directory contains 30 unmodified 3D PNG images from [Microsoft Fluent Emoji](https://github.com/microsoft/fluentui-emoji), copyright Microsoft Corporation, under the MIT License. They are grouped as 猫咪心情 (9), 软萌动物 (10), and 元气心情 (11). Chinese names, descriptions and grouping were added by this plugin; the original images were not modified.

The original license is included at `assets/stickers/LICENSE-Microsoft.txt`. `assets/stickers/manifest.json` records each original source URL, the pinned upstream revision `1ffb34c752ecf5d402f04cfb4b392c77f57c54bc`, file size, dimensions and SHA-256 hash. The catalog and artwork are shipped in the installation package and require no runtime network download. The MIT artwork retains its own license independently of the plugin's AGPL license.

## JavaScript dependencies

The plugin bundles fast-xml-parser, Zod and their included dependencies. Full dependency licenses are copied into `licenses/` in the complete installation package. Exact versions, integrity hashes and the development toolchain are locked in `package-lock.json`.

The npm archive for `@nodable/entities@3.1.0` omits its license file. Its upstream MIT license and provenance are preserved in `third-party/nodable-entities/` and copied to the installation package's `licenses/@nodable__entities/` directory.

React is provided by DeepSeek Harness and is not bundled by this project. Rolldown and node-tar are build tools. DeepSeek Harness is installed separately and remains subject to its own license and terms.

## Python runtime

The complete Windows package includes the official Python 3.13.9 embedded distribution with its original license. Python dependencies are pinned in `runtime/requirements.txt`; their distribution metadata and license files remain in the packaged `site-packages` directory. These include cryptography (Apache-2.0/BSD), Pillow (HPND), Frida (wxWindows Library Licence 3.1), CFFI (MIT), and pycparser (BSD), used by the WeChat connection and local image-processing runtime.

## WeChat runtime

Complete local packages use selected operator-provided Tencent WeChat 3.9.12.51 binaries that match the project's verified runtime. Tencent retains ownership of those proprietary binaries; AGPL does not license them. They are excluded from this source repository. The local `runtime/wechat39-engine/manifest.json` records file sizes and SHA-256 hashes. The build excludes the portable wrapper, miniapp/OCR/video-player bundles and user data.

Public protocol field layouts from [wechat7016](https://github.com/ByboyCn/wechat7016) served as a research reference. Image-upload field numbers and chunk framing were independently cross-checked against the public protobuf layouts in [wechat-api-ipad](https://github.com/ThePeppy/wechat-api-ipad/blob/main/Cilent/mm/mm.proto). The UploadMsgImg CGI-to-longlink command mapping is documented in [wechat7016's protocol URL table](https://github.com/ByboyCn/wechat7016/blob/main/WeChat.Core/Protocol/WXCGIUrl.cs). GetMsgImg request/response fields, CGI 109, 65,536-byte chunks, and original/full compression selection were reviewed against [GetMsgImgRequest.cs](https://github.com/ByboyCn/wechat7016/blob/b52df396d8e2ecce2e15ca147f17e6c221f331ae/WeChat.Core/Protocol/Protos/GetMsgImgRequest.cs), [GetMsgImgResponse.cs](https://github.com/ByboyCn/wechat7016/blob/b52df396d8e2ecce2e15ca147f17e6c221f331ae/WeChat.Core/Protocol/Protos/GetMsgImgResponse.cs), and [WXClient.Message.cs](https://github.com/ByboyCn/wechat7016/blob/b52df396d8e2ecce2e15ca147f17e6c221f331ae/WeChat.Core/Functions/WXClient.Message.cs). These are references for protocol facts; this project's uploader, downloader and response validation are independently implemented. No upstream C# or Go implementation is distributed. This repository does not grant rights to Tencent's products or marks.

This project is not affiliated with DeepSeek or Tencent. Their names identify interoperability targets, not endorsements.
