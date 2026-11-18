/**
 * 启动器即时工具：计算 / 单位换算 / Hash / GUID
 * 同步检测与求值，不引入 mathjs。
 */

import { isMathExpression } from "./launcherUtils";

export type InstantToolKind = "calc" | "unit" | "hash" | "guid";

export interface InstantToolHit {
  kind: InstantToolKind;
  /** 标签文案：计算 / 换算 / Hash / GUID */
  label: string;
  /** 回车复制的纯值 */
  value: string;
  /** 列表主标题 */
  displayName: string;
  /** 副标题说明 */
  detail: string;
  /** 结果 path，不进 open_history */
  path: string;
}

/** GUID：同一 query 复用，避免流式合并时反复换值 */
let cachedGuidQuery = "";
let cachedGuidValue = "";

/** 测试用：重置 GUID 缓存 */
export function resetGuidCacheForTests(): void {
  cachedGuidQuery = "";
  cachedGuidValue = "";
}

function getOrCreateGuid(queryKey: string): string {
  const key = queryKey.trim().toLowerCase();
  if (key === cachedGuidQuery && cachedGuidValue) {
    return cachedGuidValue;
  }
  cachedGuidQuery = key;
  cachedGuidValue =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : fallbackUuid();
  return cachedGuidValue;
}

function fallbackUuid(): string {
  // 非 WebCrypto 环境兜底
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 格式化数字：去掉多余尾零，保留合理精度 */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Object.is(n, -0)) return "0";
  const abs = Math.abs(n);
  if (abs !== 0 && (abs >= 1e12 || abs < 1e-6)) {
    return n.toExponential(10).replace(/\.?0+e/, "e").replace(/e\+?/, (m) =>
      m.includes("-") ? "e-" : "e+"
    );
  }
  // 最多 12 位有效，再清尾零
  const fixed = Number(n.toPrecision(12));
  return String(fixed);
}

// ---------- 轻量表达式求值 ----------

type Tok =
  | { t: "num"; v: number }
  | { t: "op"; v: string }
  | { t: "lparen" }
  | { t: "rparen" };

function tokenizeExpression(input: string): Tok[] | null {
  const s = input.replace(/\s+/g, "").replace(/×/g, "*").replace(/÷/g, "/");
  if (!/^[0-9+\-*/%()^.eE]+$/.test(s)) return null;
  const tokens: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "(") {
      tokens.push({ t: "lparen" });
      i++;
      continue;
    }
    if (c === ")") {
      tokens.push({ t: "rparen" });
      i++;
      continue;
    }
    if ("+-*/%^".includes(c)) {
      tokens.push({ t: "op", v: c });
      i++;
      continue;
    }
    // 数字（含科学计数）
    const m = s.slice(i).match(/^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/);
    if (!m) return null;
    const num = Number(m[0]);
    if (!Number.isFinite(num)) return null;
    tokens.push({ t: "num", v: num });
    i += m[0].length;
  }
  return tokens;
}

/** 一元 +/- 折叠进数字；返回 RPN */
function toRpn(tokens: Tok[]): Tok[] | null {
  const output: Tok[] = [];
  const ops: Tok[] = [];
  const prec: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2, "%": 2, "^": 3 };
  const rightAssoc = new Set(["^"]);
  let expectUnary = true;

  for (const tok of tokens) {
    if (tok.t === "num") {
      output.push(tok);
      expectUnary = false;
      continue;
    }
    if (tok.t === "op") {
      if (expectUnary && (tok.v === "+" || tok.v === "-")) {
        // 一元：插入 0
        output.push({ t: "num", v: 0 });
      } else if (expectUnary) {
        return null;
      }
      while (ops.length > 0) {
        const top = ops[ops.length - 1];
        if (top.t !== "op") break;
        const pTop = prec[top.v] ?? 0;
        const pCur = prec[tok.v] ?? 0;
        const shouldPop = rightAssoc.has(tok.v)
          ? pTop > pCur
          : pTop >= pCur;
        if (!shouldPop) break;
        output.push(ops.pop()!);
      }
      ops.push(tok);
      expectUnary = true;
      continue;
    }
    if (tok.t === "lparen") {
      ops.push(tok);
      expectUnary = true;
      continue;
    }
    if (tok.t === "rparen") {
      let found = false;
      while (ops.length > 0) {
        const top = ops.pop()!;
        if (top.t === "lparen") {
          found = true;
          break;
        }
        output.push(top);
      }
      if (!found) return null;
      expectUnary = false;
    }
  }
  while (ops.length > 0) {
    const top = ops.pop()!;
    if (top.t === "lparen" || top.t === "rparen") return null;
    output.push(top);
  }
  return output;
}

function evalRpn(rpn: Tok[]): number | null {
  const stack: number[] = [];
  for (const tok of rpn) {
    if (tok.t === "num") {
      stack.push(tok.v);
      continue;
    }
    if (tok.t !== "op" || stack.length < 2) return null;
    const b = stack.pop()!;
    const a = stack.pop()!;
    let r: number;
    switch (tok.v) {
      case "+":
        r = a + b;
        break;
      case "-":
        r = a - b;
        break;
      case "*":
        r = a * b;
        break;
      case "/":
        if (b === 0) return null;
        r = a / b;
        break;
      case "%":
        if (b === 0) return null;
        r = a % b;
        break;
      case "^":
        r = Math.pow(a, b);
        break;
      default:
        return null;
    }
    if (!Number.isFinite(r)) return null;
    stack.push(r);
  }
  if (stack.length !== 1) return null;
  return stack[0];
}

export function evaluateMathExpression(text: string): string | null {
  if (!isMathExpression(text)) return null;
  const tokens = tokenizeExpression(text.trim());
  if (!tokens || tokens.length === 0) return null;
  const rpn = toRpn(tokens);
  if (!rpn) return null;
  const value = evalRpn(rpn);
  if (value === null) return null;
  return formatNumber(value);
}

// ---------- 单位换算 ----------

type UnitDim = "length" | "mass" | "temp";

interface UnitDef {
  dim: UnitDim;
  /** 到基准单位的乘数（温度除外） */
  toBase: number;
  aliases: string[];
}

/** 长度基准：米；质量基准：千克 */
const UNITS: UnitDef[] = [
  { dim: "length", toBase: 1000, aliases: ["km", "公里", "千米"] },
  { dim: "length", toBase: 1, aliases: ["m", "米", "meter", "meters", "metre", "metres"] },
  { dim: "length", toBase: 0.01, aliases: ["cm", "厘米"] },
  { dim: "length", toBase: 0.001, aliases: ["mm", "毫米"] },
  { dim: "length", toBase: 1609.344, aliases: ["mi", "mile", "miles", "英里"] },
  { dim: "length", toBase: 0.9144, aliases: ["yd", "yard", "yards", "码"] },
  { dim: "length", toBase: 0.3048, aliases: ["ft", "foot", "feet", "英尺"] },
  { dim: "length", toBase: 0.0254, aliases: ["in", "inch", "inches", "英寸"] },
  { dim: "mass", toBase: 1, aliases: ["kg", "千克", "公斤"] },
  { dim: "mass", toBase: 0.001, aliases: ["g", "克", "gram", "grams"] },
  { dim: "mass", toBase: 0.45359237, aliases: ["lb", "lbs", "pound", "pounds", "磅"] },
  { dim: "mass", toBase: 0.028349523125, aliases: ["oz", "ounce", "ounces", "盎司"] },
  { dim: "temp", toBase: 0, aliases: ["c", "°c", "celsius", "摄氏", "摄氏度"] },
  { dim: "temp", toBase: 0, aliases: ["f", "°f", "fahrenheit", "华氏", "华氏度"] },
  { dim: "temp", toBase: 0, aliases: ["k", "kelvin", "开尔文", "开氏"] },
];

function findUnit(name: string): UnitDef | null {
  const key = name.trim().toLowerCase();
  if (!key) return null;
  for (const u of UNITS) {
    if (u.aliases.some((a) => a.toLowerCase() === key)) return u;
  }
  return null;
}

function canonicalUnitLabel(u: UnitDef): string {
  return u.aliases[0];
}

function tempToKelvin(value: number, unit: string): number | null {
  const k = unit.toLowerCase();
  if (k === "c" || k === "°c" || k.includes("celsius") || k.includes("摄氏")) {
    return value + 273.15;
  }
  if (k === "f" || k === "°f" || k.includes("fahrenheit") || k.includes("华氏")) {
    return ((value - 32) * 5) / 9 + 273.15;
  }
  if (k === "k" || k.includes("kelvin") || k.includes("开")) {
    return value;
  }
  return null;
}

function kelvinToTemp(k: number, unit: UnitDef): number | null {
  const a = unit.aliases[0].toLowerCase();
  if (a === "c" || a === "°c") return k - 273.15;
  if (a === "f" || a === "°f") return ((k - 273.15) * 9) / 5 + 32;
  if (a === "k") return k;
  return null;
}

const UNIT_PATTERN =
  /^([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*([a-zA-Z°\u4e00-\u9fff]+)\s*(?:to|->|=>|in|换算成?|转成?|等于?)\s*([a-zA-Z°\u4e00-\u9fff]+)$/i;

export function convertUnit(text: string): { value: string; displayName: string; detail: string } | null {
  const trimmed = text.trim();
  const m = trimmed.match(UNIT_PATTERN);
  if (!m) return null;
  const amount = Number(m[1]);
  if (!Number.isFinite(amount)) return null;
  const from = findUnit(m[2]);
  const to = findUnit(m[3]);
  if (!from || !to || from.dim !== to.dim) return null;

  let result: number;
  if (from.dim === "temp") {
    const kelvin = tempToKelvin(amount, m[2]);
    if (kelvin === null) return null;
    const converted = kelvinToTemp(kelvin, to);
    if (converted === null) return null;
    result = converted;
  } else {
    result = (amount * from.toBase) / to.toBase;
  }

  const formatted = formatNumber(result);
  const fromLabel = canonicalUnitLabel(from);
  const toLabel = canonicalUnitLabel(to);
  return {
    value: formatted,
    displayName: `${formatted} ${toLabel}`,
    detail: `${formatNumber(amount)} ${fromLabel} → ${toLabel}`,
  };
}

// ---------- Hash（同步纯 JS） ----------

function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function toHex(bytes: ArrayLike<number>): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

function rotl32(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function wordsToBytesBE(words: number[]): number[] {
  const out: number[] = [];
  for (const w of words) {
    out.push((w >>> 24) & 0xff, (w >>> 16) & 0xff, (w >>> 8) & 0xff, w & 0xff);
  }
  return out;
}

export function md5(text: string): string {
  const msg = utf8Bytes(text);
  const bitLen = msg.length * 8;
  const withOne = new Uint8Array(((msg.length + 9 + 63) & ~63));
  withOne.set(msg);
  withOne[msg.length] = 0x80;
  const view = new DataView(withOne.buffer);
  view.setUint32(withOne.length - 8, bitLen >>> 0, true);
  view.setUint32(withOne.length - 4, Math.floor(bitLen / 0x100000000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
    20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
    10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = new Array<number>(64);
  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
  }

  for (let offset = 0; offset < withOne.length; offset += 64) {
    const M = new Array<number>(16);
    for (let i = 0; i < 16; i++) {
      M[i] = view.getUint32(offset + i * 4, true);
    }
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + rotl32(F, s[i])) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return toHex(out);
}

export function sha1(text: string): string {
  const msg = utf8Bytes(text);
  const bitLen = msg.length * 8;
  const withOne = new Uint8Array((msg.length + 9 + 63) & ~63);
  withOne.set(msg);
  withOne[msg.length] = 0x80;
  const view = new DataView(withOne.buffer);
  // big-endian length
  const high = Math.floor(bitLen / 0x100000000);
  const low = bitLen >>> 0;
  view.setUint32(withOne.length - 8, high, false);
  view.setUint32(withOne.length - 4, low, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  for (let offset = 0; offset < withOne.length; offset += 64) {
    const w = new Array<number>(80);
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 80; i++) {
      w[i] = rotl32(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotl32(a, 5) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotl32(b, 30);
      b = a;
      a = temp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  return toHex(wordsToBytesBE([h0, h1, h2, h3, h4]));
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr32(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

export function sha256(text: string): string {
  const msg = utf8Bytes(text);
  const bitLen = msg.length * 8;
  const withOne = new Uint8Array((msg.length + 9 + 63) & ~63);
  withOne.set(msg);
  withOne[msg.length] = 0x80;
  const view = new DataView(withOne.buffer);
  const high = Math.floor(bitLen / 0x100000000);
  const low = bitLen >>> 0;
  view.setUint32(withOne.length - 8, high, false);
  view.setUint32(withOne.length - 4, low, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  for (let offset = 0; offset < withOne.length; offset += 64) {
    const w = new Array<number>(64);
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return toHex(wordsToBytesBE([h0, h1, h2, h3, h4, h5, h6, h7]));
}

const HASH_PREFIX =
  /^(md5|sha1|sha256|sha-256|hash)\s+([\s\S]+)$/i;

function detectHash(query: string): InstantToolHit | null {
  const m = query.trim().match(HASH_PREFIX);
  if (!m) return null;
  const algoRaw = m[1].toLowerCase().replace("-", "");
  const body = m[2];
  if (!body) return null;

  let algo: "md5" | "sha1" | "sha256";
  let value: string;
  if (algoRaw === "md5") {
    algo = "md5";
    value = md5(body);
  } else if (algoRaw === "sha1") {
    algo = "sha1";
    value = sha1(body);
  } else {
    // hash / sha256 默认 sha256
    algo = "sha256";
    value = sha256(body);
  }

  const preview = body.length > 40 ? `${body.slice(0, 40)}…` : body;
  return {
    kind: "hash",
    label: "Hash",
    value,
    displayName: value,
    detail: `${algo.toUpperCase()}（${preview}）`,
    path: `instant://hash/${algo}`,
  };
}

function detectGuid(query: string): InstantToolHit | null {
  const trimmed = query.trim();
  const lower = trimmed.toLowerCase();
  const isGuid =
    /^(生成\s*)?(guid|uuid)(\s*生成)?$/i.test(trimmed) ||
    lower === "生成guid" ||
    lower === "生成uuid" ||
    lower === "guid生成" ||
    lower === "uuid生成";
  if (!isGuid) return null;
  const value = getOrCreateGuid(trimmed);
  return {
    kind: "guid",
    label: "GUID",
    value,
    displayName: value,
    detail: "回车复制新生成的 UUID",
    path: "instant://guid",
  };
}

function detectUnit(query: string): InstantToolHit | null {
  const converted = convertUnit(query);
  if (!converted) return null;
  return {
    kind: "unit",
    label: "换算",
    value: converted.value,
    displayName: converted.displayName,
    detail: converted.detail,
    path: "instant://unit",
  };
}

function detectCalc(query: string): InstantToolHit | null {
  const value = evaluateMathExpression(query);
  if (value === null) return null;
  return {
    kind: "calc",
    label: "计算",
    value,
    displayName: `= ${value}`,
    detail: query.trim(),
    path: "instant://calc",
  };
}

/**
 * 检测即时工具命中；优先级：GUID → Hash → 单位换算 → 数学表达式
 */
export function detectInstantTools(query: string): InstantToolHit[] {
  const trimmed = (query ?? "").trim();
  if (!trimmed) {
    // 清空查询时下次 GUID 重新生成
    cachedGuidQuery = "";
    cachedGuidValue = "";
    return [];
  }

  const guid = detectGuid(trimmed);
  if (guid) return [guid];

  // 非 GUID 查询：使下次 guid/uuid 重新生成
  cachedGuidQuery = "";
  cachedGuidValue = "";

  const hash = detectHash(trimmed);
  if (hash) return [hash];

  const unit = detectUnit(trimmed);
  if (unit) return [unit];

  const calc = detectCalc(trimmed);
  if (calc) return [calc];

  return [];
}

/** 供 UI 显示标签文案 */
export function instantKindLabel(kind: InstantToolKind): string {
  switch (kind) {
    case "calc":
      return "计算";
    case "unit":
      return "换算";
    case "hash":
      return "Hash";
    case "guid":
      return "GUID";
    default:
      return "工具";
  }
}
