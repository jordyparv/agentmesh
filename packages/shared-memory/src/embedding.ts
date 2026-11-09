import { createHash } from "node:crypto";
import { EMBEDDING_DIMS } from "@agentmesh/database";

/**
 * Embedding provider contract. The default implementation is a deterministic, local
 * feature-hashing embedder (unigrams + bigrams, signed hashing, L2-normalised). It is a
 * lexical-semantic signal, not a neural embedding: it needs no network, no credentials
 * and is reproducible in tests. A neural provider can be plugged in by implementing
 * Embedder with the same dimensionality (ADR-007).
 */
export interface Embedder {
  readonly id: string;
  readonly dims: number;
  embed(text: string): number[];
}

const STOP = new Set("a an and are as at be but by for from has have in is it its of on or that the this to was were will with".split(" "));

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_./-]+/g, " ")
    .split(/\s+/)
    .flatMap((t) => (t.includes("/") || t.includes(".") ? [t, ...t.split(/[/.]/)] : [t]))
    .map((t) => t.replace(/^[-_]+|[-_]+$/g, ""))
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

/** Tiny suffix stripper so "leases"/"leasing"/"leased" collide. */
function stem(t: string): string {
  if (t.length > 5 && t.endsWith("ing")) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith("ed")) return t.slice(0, -2);
  if (t.length > 4 && t.endsWith("es")) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

export class HashingEmbedder implements Embedder {
  readonly id = "hashing-v1";
  constructor(readonly dims = EMBEDDING_DIMS) {}

  embed(text: string): number[] {
    const v = new Array<number>(this.dims).fill(0);
    const toks = tokenize(text);
    const feats = [...toks, ...toks.slice(1).map((t, i) => `${toks[i]}_${t}`)];
    for (const f of feats) {
      const h = createHash("sha1").update(f).digest();
      const idx = h.readUInt32LE(0) % this.dims;
      const sign = h[4]! & 1 ? 1 : -1;
      v[idx]! += sign * (f.includes("_") ? 0.5 : 1);
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return norm ? v.map((x) => x / norm) : v;
  }
}

export function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * (b[i] ?? 0);
  return s;
}

export const toPgVector = (v: number[]) => `[${v.map((x) => (Number.isFinite(x) ? x.toFixed(6) : "0")).join(",")}]`;
