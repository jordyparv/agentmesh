import picomatch from "picomatch";

const isGlob = (p: string) => /[*?[\]{}]/.test(p);
const norm = (p: string) => p.replace(/^\.\//, "").replace(/\/+$/, "");

/**
 * True when two path sets plausibly refer to overlapping files. Each side may contain
 * concrete paths, directories or globs. Directory prefixes count as overlap.
 */
export function pathsOverlap(a: string[], b: string[]): boolean {
  for (const x0 of a) {
    const x = norm(x0);
    for (const y0 of b) {
      const y = norm(y0);
      if (x === y || x === "**" || y === "**") return true;
      if (!isGlob(x) && !isGlob(y) && (x.startsWith(`${y}/`) || y.startsWith(`${x}/`))) return true;
      if (isGlob(x) && !isGlob(y) && picomatch(x, { dot: true })(y)) return true;
      if (isGlob(y) && !isGlob(x) && picomatch(y, { dot: true })(x)) return true;
      if (isGlob(x) && isGlob(y)) {
        // Compare the static prefixes of both globs.
        const px = x.split(/[*?[{]/)[0]!;
        const py = y.split(/[*?[{]/)[0]!;
        if (px.startsWith(py) || py.startsWith(px)) return true;
      }
    }
  }
  return false;
}
