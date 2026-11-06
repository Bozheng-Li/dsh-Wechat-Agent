'use strict';
// Bound to the exact bundled 3.9.12.51 DLL by the worker's SHA-256 manifest.
// Only this freshly-created process is instrumented; no process discovery.
let isolated = false, core = null, proxyHooked = false;
let requestCapture = null, qrRetries = 0;
const packDescriptors = new Map();
const preserveUrlScheme = new NativeCallback(() => {}, 'void', []);
const directProxy = new NativeCallback(() => 0, 'int', ['pointer', 'pointer']);
function native(module, name, ret, args) {
  return new NativeFunction(module.getExportByName(name), ret, args);
}
function variant(p) {
  if (p.add(0x18).readU64().toNumber() !== 15) p = p.readPointer();
  return p.isNull() ? '' : p.readUtf8String();
}
function mmString(p) {
  const n = p.add(8).readU32(), q = p.readPointer();
  return !n || n > 65536 || q.isNull() ? '' : q.readUtf16String(n);
}
function stdStringBytes(p) {
  const n = p.add(0x10).readU64().toNumber();
  const capacity = p.add(0x18).readU64().toNumber();
  if (!n || n > 256 || capacity > 65536) return null;
  const data = capacity >= 16 ? p.readPointer() : p;
  return data.isNull() ? null : new Uint8Array(data.readByteArray(n));
}
function installProxyBypass(adv) {
  if (proxyHooked) return;
  const regQuery = adv.findExportByName('RegQueryValueExW');
  if (!regQuery) return;
  proxyHooked = true;
  Interceptor.attach(regQuery, {
    onEnter(args) {
      this.override = !args[1].isNull() && args[1].readUtf16String() === 'ProxyEnable';
      this.data = args[4];
    },
    onLeave(ret) {
      if (this.override && ret.toInt32() === 0 && !this.data.isNull()) this.data.writeU32(0);
    },
  });
}
function installCore(mod) {
  core = mod;
  qrRetries = 0;
  // This optional desktop integration registers weixin:// for the 3.9 client.
  // Keep the user's existing 4.x handler; authentication does not use it.
  Interceptor.replace(mod.base.add(0x27066f0), preserveUrlScheme);
  // Keep real HKCU while bypassing local proxy settings inside this process only.
  Interceptor.replace(mod.base.add(0x239ea10), directProxy);
  Interceptor.replace(mod.base.add(0x237b590), preserveUrlScheme);
  // Saved-account pages otherwise hide the QR on the engine's private desktop.
  // Follow LoginWnd's own switch-account path on its UI initialization thread.
  const switchPage = new NativeFunction(mod.base.add(0x203a980), 'void', ['pointer', 'int', 'pointer', 'pointer'], { exceptions: 'propagate' });
  Interceptor.attach(mod.base.add(0x2032d60), {
    onEnter(args) { this.window = args[0]; },
    onLeave() {
      const page = this.window.add(0xcd8).readU32();
      send({ kind: 'login-page', page });
      if (page === 2 || page === 3) {
        const empty = Memory.alloc(0x40); empty.writeByteArray(new Uint8Array(0x40));
        switchPage(this.window, 1, empty, empty.add(0x20));
        send({ kind: 'qr-page' });
      }
    },
  });
  // If the initial 3s GetLoginQRCode scene finishes with 0x305 before the channel
  // is ready, re-trigger QR fetching on the UI thread instead of waiting for a click.
  Interceptor.attach(mod.base.add(0x2030680), {
    onEnter(args) {
      this.event = args[1].toInt32();
      this.window = args[0].sub(0x978);
    },
    onLeave() {
      if (this.event === 0x305 && qrRetries < 4) {
        qrRetries++;
        const empty = Memory.alloc(0x40); empty.writeByteArray(new Uint8Array(0x40));
        switchPage(this.window, 1, empty, empty.add(0x20));
        send({ kind: 'qr-refresh', attempt: qrRetries });
      }
    },
  });
  // Hybrid decryption is the already-verified login boundary, never MMTLS/AEAD.
  Interceptor.attach(mod.base.add(0x3d1e2c0), {
    onEnter(args) { this.out = args[3]; this.client = args[0].toString(); },
    onLeave() {
      try {
        const n = this.out.add(0x10).readU64().toNumber();
        if (n < 1 || n > 1024 * 1024) return;
        const p = this.out.add(0x18).readU64().toNumber() >= 16 ? this.out.readPointer() : this.out;
        send({ kind: 'plaintext', context: this.client }, p.readByteArray(n));
      } catch (error) { send({ kind: 'hook-error', stage: 'login-decrypt' }); }
    },
  });
  // The pack descriptor owns both the per-request checksum material (+0x08)
  // and encryption key (+0x50). Keep only in-memory copies; the worker receives
  // them over its private pipe and never writes them to stdout or diagnostics.
  Interceptor.attach(mod.base.add(0x3b62400), {
    onEnter(args) {
      try {
        const descriptor = args[2];
        const s08 = stdStringBytes(descriptor.add(8));
        const key = stdStringBytes(descriptor.add(0x50));
        if (s08 && s08.length) packDescriptors.set(Process.getCurrentThreadId(), s08);
        send({ kind: 'pack-observed', descriptor0: descriptor.readU32(),
               descriptor4: descriptor.add(4).readU32(),
               keyBytes: key ? key.length : 0, s08Bytes: s08 ? s08.length : 0,
               thread: Process.getCurrentThreadId() });
      } catch (error) { send({ kind: 'hook-error', stage: 'pack-descriptor' }); }
    },
  });
  // EncryptPack receives the exact AES material selected for this frame.
  // Pair it with the descriptor captured on the same thread and emit one
  // candidate record. The frame itself still comes from the real socket.
  Interceptor.attach(mod.base.add(0x3b62d50), {
    onEnter(args) {
      try {
        const key = stdStringBytes(args[2]);
        const s08 = packDescriptors.get(Process.getCurrentThreadId());
        if (!key || !s08 || !key.length || !s08.length) {
          send({ kind: 'pack-miss', keyBytes: key ? key.length : 0,
                 s08Bytes: s08 ? s08.length : 0,
                 encType: args[3].toInt32(), thread: Process.getCurrentThreadId() });
          return;
        }
        const payload = new Uint8Array(2 + key.length + s08.length);
        payload[0] = key.length; payload[1] = s08.length;
        payload.set(key, 2); payload.set(s08, 2 + key.length);
        send({ kind: 'crypto', keyLength: key.length, s08Length: s08.length, encType: args[3].toInt32(), thread: Process.getCurrentThreadId() }, payload.buffer);
      } catch (error) { send({ kind: 'hook-error', stage: 'pack-encrypt' }); }
    },
  });
  send({ kind: 'core-ready', path: mod.path });
}
function installNetwork(ws) {
  const peer = native(ws, 'getpeername', 'int', ['pointer', 'pointer', 'pointer']);
  function outgoing(socket, p, n) {
    if (n < 59 || n > 16 * 1024 * 1024) return;
    const b = new Uint8Array(p.readByteArray(Math.min(n, 59)));
    if (b[4] !== 0 || b[5] !== 0x10 || b[6] !== 0 || b[7] !== 1 || b[16] !== 0xbf) return;
    const total = (b[0] * 0x1000000 + (b[1] << 16) + (b[2] << 8) + b[3]);
    if (total > n || total < 59) return;
    const sa = Memory.alloc(128), size = Memory.alloc(4); size.writeU32(128);
    let host = null, port = null;
    if (peer(socket, sa, size) === 0 && sa.readU16() === 2) {
      const address = new Uint8Array(sa.readByteArray(8));
      host = Array.from(address.slice(4, 8)).join('.'); port = address[2] * 256 + address[3];
    }
    send({ kind: 'longlink', host, port }, p.readByteArray(total));
  }
  Interceptor.attach(ws.getExportByName('send'), {
    onEnter(args) { try { outgoing(args[0], args[1], args[2].toInt32()); } catch (error) { send({ kind: 'hook-error', stage: 'longlink' }); } },
  });
  Interceptor.attach(ws.getExportByName('WSASend'), {
    onEnter(args) {
      try {
        for (let i = 0; i < Math.min(args[2].toInt32(), 4); i++) {
          const buffer = args[1].add(i * 16);
          outgoing(args[0], buffer.add(8).readPointer(), buffer.readU32());
        }
      } catch (error) { send({ kind: 'hook-error', stage: 'longlink' }); }
    },
  });
}
rpc.exports = {
  watchRequests() {
    if (!core) throw new Error('Native core not ready');
    if (!requestCapture) requestCapture = Interceptor.attach(core.base.add(0x3d1ef50), {
      onEnter(args) {
        const n = args[2].toInt32();
        if (n > 0 && n <= 1024 * 1024) send({ kind: 'request', context: args[0].toString() }, args[1].readByteArray(n));
      },
    });
  },
  refreshQr() {
    if (!core) return false;
    const center = new NativeFunction(core.base.add(0x23865c0), 'pointer', [])();
    if (center.isNull()) return false;
    const event = Memory.alloc(32); event.writeByteArray(new Uint8Array(32));
    event.writeU32(0x306);
    new NativeFunction(core.base.add(0x23878f0), 'void', ['pointer', 'pointer'])(center, event);
    send({ kind: 'qr-refresh' });
    return true;
  },
  isolate(profile) {
    if (isolated) throw new Error('Lifecycle hooks already installed');
    // HKCU, shell folders and Tencent\\WeChat remain the real user's settings.
    // Replacing them with empty application directories breaks native login.
    isolated = true;
    Process.attachModuleObserver({ onAdded(mod) {
      const name = mod.name.toLowerCase();
      if (name === 'advapi32.dll') installProxyBypass(mod);
      if (name === 'wechatwin.dll') installCore(mod);
      if (name === 'ws2_32.dll') installNetwork(mod);
    } });
    return { isolated, profile };
  },
  account() {
    if (!core) return null;
    const svc = new NativeFunction(core.base.add(0x1b5ca40), 'pointer', [])();
    if (svc.isNull() || svc.add(0x7f8).readU64().toString() === '0') return null;
    return { wxid: variant(svc.add(0x80)), nickname: variant(svc.add(0x1e8)) };
  },
  contacts() {
    if (!core) return [];
    const manager = new NativeFunction(core.base.add(0x1b489d0), 'pointer', [])();
    const out = Memory.alloc(24); out.writeByteArray(new Uint8Array(24));
    const rc = new NativeFunction(core.base.add(0x21acbe0), 'int', ['pointer', 'pointer'])(manager, out);
    if (rc !== 1 || out.readPointer().isNull()) return [];
    const begin = out.readPointer(), end = out.add(16).readPointer();
    const count = end.sub(begin).toInt32() / 0x6a8, result = [];
    if (!Number.isInteger(count) || count < 0 || count > 50000) throw new Error('Invalid native contact list');
    for (let i = 0; i < count; i++) {
      const p = begin.add(i * 0x6a8);
      result.push({ id: mmString(p.add(0x10)), nickname: mmString(p.add(0xa0)), remark: mmString(p.add(0x80)) });
    }
    return result;
  },
};
