// amiibo.js — Amiibo parsing, validation, hex dump formatting, and database resolution
//
// Attributions & Credits:
// - Reverse-engineered NTAG215 structure & checks by malc0mn (https://github.com/malc0mn/amiigo)
// - Web metadata lookups inspired by pathawks (https://github.com/pathawks/amiigo-web)
// - Amiibo database & character artwork by AmiiboAPI (https://github.com/N3evin/AmiiboAPI)

export const NTAG215_SIZE = 540;

export const SERIES_NAMES = {
  0x00: "Super Smash Bros.",
  0x01: "Super Mario",
  0x02: "Chibi-Robo",
  0x03: "Yoshi's Woolly World",
  0x04: "Splatoon",
  0x05: "Animal Crossing",
  0x06: "8-Bit Mario",
  0x07: "Skylanders",
  0x08: "Dark Souls",
  0x09: "The Legend of Zelda",
  0x0a: "Shovel Knight",
  0x0c: "Kirby",
  0x0d: "Pokemon",
  0x0e: "Mario Sports Superstars",
  0x0f: "Monster Hunter",
  0x10: "BoxBoy!",
  0x11: "Pikmin",
  0x12: "Fire Emblem",
  0x13: "Metroid",
  0x14: "Others",
  0x15: "Mega Man",
  0x16: "Diablo",
  0x17: "Power Pro",
  0x18: "Yu-Gi-Oh!",
};

export const FIGURE_TYPES = {
  0: "Figure",
  1: "Card",
  2: "Yarn",
  3: "Band",
};

export function toHex(bytes) {
  if (!bytes) return "";
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

export function formatUid(uid) {
  if (!uid) return "--";
  return Array.from(uid, (b) => b.toString(16).padStart(2, "0").toUpperCase()).join(":");
}

export function parseAmiibo(buffer) {
  if (!buffer || buffer.length < 96) {
    return {
      isValidSize: false,
      isAmiibo: false,
      uid: null,
      uidHex: "",
      uidFormatted: "--",
      uidValid: false,
      modelInfo: null,
    };
  }

  const isValidSize = buffer.length === NTAG215_SIZE;

  // NTAG215 7-byte UID: bytes 0..2, then 4..7
  const uid = new Uint8Array([
    buffer[0], buffer[1], buffer[2],
    buffer[4], buffer[5], buffer[6], buffer[7],
  ]);

  // ISO/IEC 14443-3 check bytes
  const bcc0 = buffer[3];
  const bcc1 = buffer[8];
  const expectedBcc0 = 0x88 ^ buffer[0] ^ buffer[1] ^ buffer[2];
  const expectedBcc1 = buffer[4] ^ buffer[5] ^ buffer[6] ^ buffer[7];
  const uidValid = bcc0 === expectedBcc0 && bcc1 === expectedBcc1;

  // ModelInfo is at offset 84..95 (12 bytes)
  const mi = buffer.slice(84, 96);
  // Byte 91 is always 0x02 on genuine Amiibo tags, and figure type (byte 87) is <= 3
  const isAmiibo = mi[7] === 0x02 && mi[3] <= 0x03;

  let modelInfo = null;
  if (isAmiibo) {
    const idWord = (mi[0] << 8) | mi[1];
    const headHex = toHex(mi.slice(0, 4)).toLowerCase();
    const tailHex = toHex(mi.slice(4, 8)).toLowerCase();
    const fullIdHex = `${headHex}${tailHex}`;

    modelInfo = {
      idHex: fullIdHex.toUpperCase(),
      headHex,
      tailHex,
      gameId: idWord & 0x3ff,
      characterId: (idWord >> 10) & 0x3f,
      characterVariant: mi[2],
      figureType: mi[3],
      figureTypeName: FIGURE_TYPES[mi[3]] ?? `Unknown (${mi[3]})`,
      modelNumber: (mi[4] << 8) | mi[5],
      series: mi[6],
      seriesName: SERIES_NAMES[mi[6]] ?? `Unknown (0x${mi[6].toString(16)})`,
    };
  }

  // Heuristic for decrypted / amiitool dumps:
  // In decrypted amiitool dumps, bytes 0..16 contain BCC1, Int, StaticLock, etc.
  // rather than the standard NTAG215 UID at bytes 0..8.
  let isDecrypted = false;
  if (isValidSize && buffer[0] === buffer[8] && buffer[1] === buffer[9]) {
    // Possible decrypted marker
    isDecrypted = true;
  }

  return {
    isValidSize,
    isAmiibo,
    isDecrypted,
    uid,
    uidHex: toHex(uid),
    uidFormatted: formatUid(uid),
    uidValid,
    modelInfo,
  };
}

export function formatHexDump(buffer) {
  if (!buffer || buffer.length === 0) return "";
  const lines = [];
  for (let offset = 0; offset < buffer.length; offset += 16) {
    const hex = [];
    let ascii = "";
    for (let i = 0; i < 16; i++) {
      if (offset + i < buffer.length) {
        const b = buffer[offset + i];
        hex.push(b.toString(16).padStart(2, "0"));
        ascii += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".";
      } else {
        hex.push("  ");
        ascii += " ";
      }
    }
    const addr = offset.toString(16).padStart(4, "0").toUpperCase();
    lines.push(`${addr}  ${hex.slice(0, 8).join(" ")}  ${hex.slice(8, 16).join(" ")}  |${ascii}|`);
  }
  return lines.join("\n");
}

// Database cache using IndexedDB
const IDB_NAME = "powersaves_portal";
const IDB_STORE = "amiibo_db";
const AMIIBO_DB_URL = "https://raw.githubusercontent.com/N3evin/AmiiboAPI/master/database/amiibo.json";

let dbPromise = null;
function getDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

let dbLoaded = false;
export async function fetchAmiiboMetadata(modelInfo) {
  if (!modelInfo || !modelInfo.idHex) return null;

  const key = modelInfo.idHex.toLowerCase();
  const db = await getDb().catch(() => null);

  if (db && !dbLoaded) {
    try {
      const tx = db.transaction(IDB_STORE, "readonly");
      const cached = await new Promise((res) => {
        const req = tx.objectStore(IDB_STORE).get(key);
        req.onsuccess = () => res(req.result);
        req.onerror = () => res(null);
      });
      if (cached) {
        dbLoaded = true;
        return cached;
      }
    } catch (e) {
      // Continue to network fetch
    }
  }

  // Construct direct AmiiboAPI image URL fallback
  const fallbackImageUrl = `https://raw.githubusercontent.com/N3evin/AmiiboAPI/master/images/icon_${modelInfo.headHex}-${modelInfo.tailHex}.png`;

  try {
    const resp = await fetch(AMIIBO_DB_URL, { signal: AbortSignal.timeout(6000) });
    if (!resp.ok) {
      return {
        name: null,
        imageUrl: fallbackImageUrl,
      };
    }
    const json = await resp.json();
    const amiibos = json.amiibos || {};

    // Populate IndexedDB in background
    if (db) {
      try {
        const writeTx = db.transaction(IDB_STORE, "readwrite");
        const store = writeTx.objectStore(IDB_STORE);
        for (const [k, v] of Object.entries(amiibos)) {
          const cleanKey = k.slice(2).toLowerCase();
          store.put({
            name: v.name,
            gameSeries: v.gameSeries,
            amiiboSeries: v.amiiboSeries,
            imageUrl: `https://raw.githubusercontent.com/N3evin/AmiiboAPI/master/images/icon_${cleanKey.slice(0, 8)}-${cleanKey.slice(8, 16)}.png`,
          }, cleanKey);
        }
        dbLoaded = true;
      } catch (err) {
        // Ignore DB save errors
      }
    }

    const hit = amiibos[`0x${key}`];
    if (hit) {
      return {
        name: hit.name,
        gameSeries: hit.gameSeries,
        amiiboSeries: hit.amiiboSeries,
        imageUrl: fallbackImageUrl,
      };
    }
  } catch (err) {
    // Network failed, return fallback
  }

  return {
    name: null,
    imageUrl: fallbackImageUrl,
  };
}

export function downloadBin(buffer, filename) {
  const blob = new Blob([buffer], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

