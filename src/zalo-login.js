import fs from "node:fs";
import { Zalo, LoginQRCallbackEventType } from "zca-js";
import { config } from "./config.js";

export function loadCreds(credsPath = config.credsPath) {
  try {
    return JSON.parse(fs.readFileSync(credsPath, "utf-8"));
  } catch {
    return null;
  }
}

// Cookie header for file downloads (format "a=1; b=2")
export function getCookieHeader(credsPath = config.credsPath) {
  const c = loadCreds(credsPath);
  const arr = c?.cookie;
  if (!Array.isArray(arr)) return null;
  const s = arr
    .filter((x) => x?.name && x?.value !== undefined)
    .map((x) => `${x.name}=${x.value}`)
    .join("; ");
  return s || null;
}

// zca-js v2 requires you to provide this when sending images by file path
async function imageMetadataGetter(filePath) {
  try {
    const { default: sharp } = await import("sharp");
    const meta = await sharp(filePath).metadata();
    const st = fs.statSync(filePath);
    if (!meta.width || !meta.height) return null;
    return { width: meta.width, height: meta.height, size: st.size };
  } catch {
    return null;
  }
}

function saveCreds(creds, targetPath = config.credsPath) {
  fs.writeFileSync(targetPath, JSON.stringify(creds, null, 2));
  console.log(`[zalo] Saved creds to ${targetPath} (KEEP THIS FILE SECRET)`);
}

export async function loginZalo(opts = {}) {
  const credsPath = opts.credsPath ?? config.credsPath;
  const qrPath = opts.qrPath ?? config.qrPath;
  const label = opts.label ?? "zalo";
  const saved = loadCreds(credsPath);
  if (saved?.cookie && saved?.imei && saved?.userAgent) {
    try {
      console.log(`[${label}] Logging in with saved creds...`);
      // selfListen stays true so progress bubbles can be tracked/deleted
      // via echo; dual mode filters them by uid instead of prefix.
      const zalo = new Zalo({ selfListen: true, checkUpdate: false, logging: false, imageMetadataGetter });
      const api = await zalo.login({
        cookie: saved.cookie,
        imei: saved.imei,
        userAgent: saved.userAgent,
      });
      console.log(`[${label}] Cookie login OK`);
      return api;
    } catch (e) {
      console.log(`[${label}] Saved creds expired, switching to QR:`, e?.message ?? e);
    }
  }

  console.log(`[${label}] Generating QR login, open ${qrPath} to scan...`);
  const zalo = new Zalo({ selfListen: true, checkUpdate: false, logging: false, imageMetadataGetter });
  const api = await zalo.loginQR({ qrPath }, async (event) => {
    if (event.type === LoginQRCallbackEventType.QRCodeGenerated) {
      // With a callback, the lib does NOT save the file itself - call saveToFile manually
      await event.actions.saveToFile(qrPath);
      console.log(`[${label}] New QR (token ${event.data.token}). Scan file: ${qrPath}`);
    } else if (event.type === LoginQRCallbackEventType.QRCodeScanned) {
      console.log(`[${label}] QR scanned: ${event.data.display_name}, confirm on your phone...`);
    } else if (event.type === LoginQRCallbackEventType.QRCodeExpired) {
      console.log(`[${label}] QR expired, generating a new one...`);
      event.actions.retry();
    } else if (event.type === LoginQRCallbackEventType.GotLoginInfo) {
      saveCreds(
        {
          cookie: event.data.cookie,
          imei: event.data.imei,
          userAgent: event.data.userAgent,
        },
        credsPath
      );
    }
  });
  console.log(`[${label}] QR login OK`);
  return api;
}

// Dedicated bot account (dual mode). Falls back to creating the creds file
// on first QR login, which is also the auto-detect signal for next runs.
export async function loginBot() {
  return loginZalo({ credsPath: config.botCredsPath, qrPath: config.botQrPath, label: "zalo-bot" });
}
