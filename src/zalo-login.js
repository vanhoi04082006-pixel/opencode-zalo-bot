import fs from "node:fs";
import { Zalo, LoginQRCallbackEventType } from "zca-js";
import { config } from "./config.js";

export function loadCreds() {
  try {
    return JSON.parse(fs.readFileSync(config.credsPath, "utf-8"));
  } catch {
    return null;
  }
}

// Cookie header for file downloads (format "a=1; b=2")
export function getCookieHeader() {
  const c = loadCreds();
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

function saveCreds(creds) {
  fs.writeFileSync(config.credsPath, JSON.stringify(creds, null, 2));
  console.log("[zalo] Saved creds to .zalo-creds.json (KEEP THIS FILE SECRET)");
}

export async function loginZalo() {
  const saved = loadCreds();
  if (saved?.cookie && saved?.imei && saved?.userAgent) {
    try {
      console.log("[zalo] Logging in with saved creds...");
      const zalo = new Zalo({ selfListen: true, checkUpdate: false, logging: false, imageMetadataGetter });
      const api = await zalo.login({
        cookie: saved.cookie,
        imei: saved.imei,
        userAgent: saved.userAgent,
      });
      console.log("[zalo] Cookie login OK");
      return api;
    } catch (e) {
      console.log("[zalo] Saved creds expired, switching to QR:", e?.message ?? e);
    }
  }

  console.log("[zalo] Generating QR login, open zalo-qr.png to scan...");
  const zalo = new Zalo({ selfListen: true, checkUpdate: false, logging: false, imageMetadataGetter });
  const api = await zalo.loginQR({ qrPath: config.qrPath }, async (event) => {
    if (event.type === LoginQRCallbackEventType.QRCodeGenerated) {
      // With a callback, the lib does NOT save the file itself - call saveToFile manually
      await event.actions.saveToFile(config.qrPath);
      console.log(`[zalo] New QR (token ${event.data.token}). Scan file: ${config.qrPath}`);
    } else if (event.type === LoginQRCallbackEventType.QRCodeScanned) {
      console.log(`[zalo] QR scanned: ${event.data.display_name}, confirm on your phone...`);
    } else if (event.type === LoginQRCallbackEventType.QRCodeExpired) {
      console.log("[zalo] QR expired, generating a new one...");
      event.actions.retry();
    } else if (event.type === LoginQRCallbackEventType.GotLoginInfo) {
      saveCreds({
        cookie: event.data.cookie,
        imei: event.data.imei,
        userAgent: event.data.userAgent,
      });
    }
  });
  console.log("[zalo] QR login OK");
  return api;
}
