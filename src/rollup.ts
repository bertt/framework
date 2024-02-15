import {access, constants, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {nodeResolve} from "@rollup/plugin-node-resolve";
import {type CallExpression} from "acorn";
import {simple} from "acorn-walk";
import {build} from "esbuild";
import type {AstNode, OutputChunk, Plugin, ResolveIdResult} from "rollup";
import {rollup} from "rollup";
import esbuild from "rollup-plugin-esbuild";
import {isEnoent} from "./error.js";
import {getClientPath, prepareOutput} from "./files.js";
import {getStringLiteralValue, isStringLiteral} from "./javascript/features.js";
import {isPathImport, resolveNpmImport} from "./javascript/imports.js";
import {getObservableUiOrigin} from "./observableApiClient.js";
import {Sourcemap} from "./sourcemap.js";
import {THEMES, renderTheme} from "./theme.js";
import {faint} from "./tty.js";
import {relativeUrl} from "./url.js";

const STYLE_MODULES = {
  "observablehq:default.css": getClientPath("./src/style/default.css"),
  ...Object.fromEntries(THEMES.map(({name, path}) => [`observablehq:theme-${name}.css`, path]))
};

function rewriteInputsNamespace(code: string) {
  return code.replace(/\b__ns__\b/g, "inputs-3a86ea");
}

const INLINE_CSS = Object.fromEntries(
  ["svg", "png", "jpeg", "jpg", "gif", "eot", "otf", "woff", "woff2"].map((ext) => [`.${ext}`, "file" as const])
);
export async function bundleStyles({
  path,
  theme,
  includePath
}: {
  path?: string;
  theme?: string[];
  includePath?: string;
}): Promise<string> {
  const result = await build({
    bundle: true,
    loader: INLINE_CSS,
    ...(path ? {entryPoints: [path]} : {stdin: {contents: renderTheme(theme!), loader: "css"}}),
    write: false,
    outdir: "/_import",
    assetNames: "assets/[name].[hash]",
    alias: STYLE_MODULES
  });
  let text;
  for (let i = 0, n = result.outputFiles.length; i < n; ++i) {
    const file = result.outputFiles[i];
    if (typeof includePath === "string" && i < n - 1) {
      const out = join(includePath, file.path);
      try {
        await access(out, constants.R_OK);
      } catch (error) {
        if (!isEnoent(error)) throw error;
        console.log(faint("css asset"), out);
        await prepareOutput(out);
        await writeFile(out, file.contents);
      }
    } else text = file.text;
  }
  return path === "src/client/stdlib/inputs.css" ? rewriteInputsNamespace(text) : text;
}

export async function rollupClient(clientPath: string, {minify = false} = {}): Promise<string> {
  const bundle = await rollup({
    input: clientPath,
    external: [/^https:/],
    plugins: [
      nodeResolve({resolveOnly: ["@observablehq/inputs"]}),
      importResolve(clientPath),
      esbuild({
        target: "es2022",
        exclude: [], // don’t exclude node_modules
        minify,
        define: {
          "process.env.OBSERVABLE_ORIGIN": JSON.stringify(String(getObservableUiOrigin()).replace(/\/$/, ""))
        }
      }),
      importMetaResolve()
    ]
  });
  try {
    const output = await bundle.generate({format: "es"});
    let code = output.output.find((o): o is OutputChunk => o.type === "chunk")!.code; // TODO don’t assume one chunk?
    code = rewriteTypeScriptImports(code);
    code = rewriteInputsNamespace(code); // TODO only for inputs
    return code;
  } finally {
    await bundle.close();
  }
}

// For reasons not entirely clear (to me), when we resolve a relative import to
// a TypeScript file, such as resolving observablehq:stdlib/foo to
// ./src/client/stdlib/foo.js, Rollup (or rollup-plugin-esbuild?) notices that
// there is a foo.ts and rewrites the import to foo.ts. But the imported file at
// runtime won’t be TypeScript and will only exist at foo.js, so here we rewrite
// the import back to what it was supposed to be. This is a dirty hack but it
// gets the job done. 🤷 https://github.com/observablehq/framework/issues/478
function rewriteTypeScriptImports(code: string): string {
  return code.replace(/(?<=\bimport\(([`'"])[\w./]+)\.ts(?=\1\))/g, ".js");
}

function importResolve(clientPath: string): Plugin {
  return {
    name: "resolve-import",
    resolveId: (specifier) => resolveImport(clientPath, specifier),
    resolveDynamicImport: (specifier) => resolveImport(clientPath, specifier)
  };
}

// TODO Consolidate with createImportResolver.
async function resolveImport(source: string, specifier: string | AstNode): Promise<ResolveIdResult> {
  return typeof specifier !== "string"
    ? null
    : specifier.startsWith("observablehq:")
    ? {id: relativeUrl(source, getClientPath(`./src/client/${specifier.slice("observablehq:".length)}.js`)), external: true} // prettier-ignore
    : specifier === "npm:@observablehq/runtime"
    ? {id: relativeUrl(source, getClientPath("./src/client/runtime.js")), external: true}
    : specifier === "npm:@observablehq/stdlib"
    ? {id: relativeUrl(source, getClientPath("./src/client/stdlib.js")), external: true}
    : specifier === "npm:@observablehq/dot"
    ? {id: relativeUrl(source, getClientPath("./src/client/stdlib/dot.js")), external: true} // TODO publish to npm
    : specifier === "npm:@observablehq/duckdb"
    ? {id: relativeUrl(source, getClientPath("./src/client/stdlib/duckdb.js")), external: true} // TODO publish to npm
    : specifier === "npm:@observablehq/inputs"
    ? {id: relativeUrl(source, getClientPath("./src/client/stdlib/inputs.js")), external: true} // TODO publish to npm
    : specifier === "npm:@observablehq/mermaid"
    ? {id: relativeUrl(source, getClientPath("./src/client/stdlib/mermaid.js")), external: true} // TODO publish to npm
    : specifier === "npm:@observablehq/tex"
    ? {id: relativeUrl(source, getClientPath("./src/client/stdlib/tex.js")), external: true} // TODO publish to npm
    : specifier === "npm:@observablehq/sqlite"
    ? {id: relativeUrl(source, getClientPath("./src/client/stdlib/sqlite.js")), external: true} // TODO publish to npm
    : specifier === "npm:@observablehq/xlsx"
    ? {id: relativeUrl(source, getClientPath("./src/client/stdlib/xlsx.js")), external: true} // TODO publish to npm
    : specifier === "npm:@observablehq/zip"
    ? {id: relativeUrl(source, getClientPath("./src/client/stdlib/zip.js")), external: true} // TODO publish to npm
    : specifier.startsWith("npm:")
    ? {id: await resolveNpmImport(specifier.slice("npm:".length))}
    : source !== specifier && !isPathImport(specifier) && specifier !== "@observablehq/inputs"
    ? {id: await resolveNpmImport(specifier), external: true}
    : null;
}

function importMetaResolve(): Plugin {
  return {
    name: "resolve-import-meta-resolve",
    async transform(code) {
      const program = this.parse(code);
      const resolves: CallExpression[] = [];

      simple(program, {
        CallExpression(node) {
          if (
            node.callee.type === "MemberExpression" &&
            node.callee.object.type === "MetaProperty" &&
            node.callee.property.type === "Identifier" &&
            node.callee.property.name === "resolve" &&
            node.arguments.length === 1 &&
            isStringLiteral(node.arguments[0])
          ) {
            resolves.push(node);
          }
        }
      });

      if (!resolves.length) return null;

      const output = new Sourcemap(code);
      for (const node of resolves) {
        const specifier = getStringLiteralValue(node.arguments[0]);
        if (specifier.startsWith("npm:")) {
          const resolution = await resolveNpmImport(specifier.slice("npm:".length));
          output.replaceLeft(node.start, node.end, JSON.stringify(resolution));
        }
      }

      return {code: String(output)};
    }
  };
}
