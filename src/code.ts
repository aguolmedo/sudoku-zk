import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import "highlight.js/styles/github.css";

hljs.registerLanguage("typescript", typescript);

/** Pull a `// #region name` block out of a source file, highlighted and with its indentation stripped. */
export function region(source: string, name: string): string {
  const match = source.replace(/\r\n/g, "\n").match(new RegExp(`// #region ${name}\\n([\\s\\S]*?)\\n\\s*// #endregion`));
  if (!match) throw new Error(`Missing "#region ${name}"`);
  const lines = match[1].split("\n");
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.search(/\S/)));
  const code = lines.map((l) => l.slice(indent)).join("\n");
  return hljs.highlight(code, { language: "typescript" }).value;
}
