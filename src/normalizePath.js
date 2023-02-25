export default function normalizePath(filePath) {
  const segments = filePath.split("/").filter((s) => !!s && s !== ".");
  if (segments.length === 0) {
    segments.push("");
  }
  segments.unshift("");
  return segments.join("/");
}
