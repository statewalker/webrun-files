/**
 * `.projectignore` — a `.gitignore`-style exclusion list at a project's root that
 * keeps matching sources out of scanning / indexing. Parsed once per scan into a
 * predicate over project-relative file URIs.
 *
 * Supported subset (pragmatic, not full git semantics):
 *  - `#` comments and blank lines are ignored.
 *  - `!pattern` re-includes (negation); last matching rule wins.
 *  - `*` matches within a path segment, `**` across segments, `?` one non-slash char.
 *  - A pattern containing a `/` (including a leading one) is anchored to the project
 *    root; otherwise it matches a name at any depth.
 *  - A trailing `/` (directory marker) is accepted; directories match their subtree.
 *  - Matching a directory excludes everything beneath it.
 */

export interface IgnoreRule {
  negate: boolean;
  regex: RegExp;
}

/** Translate a glob fragment into a regex body (segment-aware `*` / `**` / `?`). */
function globToRegex(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === undefined) continue;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return out;
}

/** Compile `.projectignore` text into an ordered rule list. */
export function compileIgnoreRules(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1).trim();
    }
    line = line.replace(/\/+$/, ""); // directory marker — subtree matched anyway
    const anchored = line.includes("/"); // a slash (incl. leading) anchors to root
    line = line.replace(/^\/+/, "");
    if (!line) continue;
    const body = globToRegex(line);
    rules.push({
      negate,
      regex: anchored ? new RegExp(`^${body}$`) : new RegExp(`(?:^|/)${body}$`),
    });
  }
  return rules;
}

/** Ancestor-or-self path prefixes of a uri: `a/b/c` → [`a`, `a/b`, `a/b/c`]. */
function selfAndAncestors(uri: string): string[] {
  const segments = uri.split("/");
  const paths: string[] = [];
  for (let i = 1; i <= segments.length; i++) paths.push(segments.slice(0, i).join("/"));
  return paths;
}

/**
 * Build a predicate `(uri) => boolean` from `.projectignore` text. A file is
 * excluded when its last matching rule (over the file and every ancestor
 * directory) is a non-negated pattern. Empty / missing text excludes nothing.
 */
export function makeProjectIgnore(text: string | undefined): (uri: string) => boolean {
  const rules = compileIgnoreRules(text ?? "");
  if (rules.length === 0) return () => false;
  return (uri: string) => {
    const candidates = selfAndAncestors(uri);
    let ignored = false;
    for (const rule of rules) {
      if (candidates.some((c) => rule.regex.test(c))) ignored = !rule.negate;
    }
    return ignored;
  };
}
