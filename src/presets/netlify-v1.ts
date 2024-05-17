import { existsSync, promises as fsp } from "node:fs";
import { join, dirname } from "pathe";
import { defineNitroPreset } from "../preset";
import type { Nitro } from "../types";
import nitroPkg from "../../package.json";

// Netlify functions
export const netlify = defineNitroPreset({
  extends: "aws-lambda",
  entry: "#internal/nitro/entries/netlify-v1",
  output: {
    dir: "{{ rootDir }}/.netlify/functions-internal",
    publicDir: "{{ rootDir }}/dist",
  },
  rollupConfig: {
    output: {
      entryFileNames: "server.mjs",
    },
  },
  hooks: {
    "rollup:before": (nitro: Nitro) => {
      deprecateSWR(nitro);
    },
    async compiled(nitro: Nitro) {
      await writeHeaders(nitro);
      await writeRedirects(nitro);
      await writeDeployConfig(nitro);

      const functionConfig = {
        config: { nodeModuleFormat: "esm" },
        version: 1,
      };
      const functionConfigPath = join(
        nitro.options.output.serverDir,
        "server.json"
      );
      await fsp.writeFile(functionConfigPath, JSON.stringify(functionConfig));
    },
  },
});

// Netlify builder
export const netlifyBuilder = defineNitroPreset({
  extends: "netlify",
  entry: "#internal/nitro/entries/netlify-v1-builder",
  hooks: {
    "rollup:before": (nitro: Nitro) => {
      deprecateSWR(nitro);
    },
  },
});

// Netlify edge
export const netlifyEdge = defineNitroPreset({
  extends: "base-worker",
  entry: "#internal/nitro/entries/netlify-edge",
  exportConditions: ["netlify"],
  output: {
    serverDir: "{{ rootDir }}/.netlify/edge-functions/server",
    publicDir: "{{ rootDir }}/dist",
  },
  rollupConfig: {
    output: {
      entryFileNames: "server.js",
      format: "esm",
    },
  },
  unenv: {
    polyfill: ["#internal/nitro/polyfill/deno-env"],
  },
  hooks: {
    "rollup:before": (nitro: Nitro) => {
      deprecateSWR(nitro);
    },
    async compiled(nitro: Nitro) {
      await writeHeaders(nitro);
      await writeRedirects(nitro);
      await writeDeployConfig(nitro);

      // https://docs.netlify.com/edge-functions/create-integration/
      const manifest = {
        version: 1,
        functions: [
          {
            path: "/*",
            name: "nitro server handler",
            function: "server",
            generator: `${nitroPkg.name}@${nitroPkg.version}`,
          },
        ],
      };
      const manifestPath = join(
        nitro.options.rootDir,
        ".netlify/edge-functions/manifest.json"
      );
      await fsp.mkdir(dirname(manifestPath), { recursive: true });
      await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    },
  },
});

export const netlifyStatic = defineNitroPreset({
  extends: "static",
  output: {
    publicDir: "{{ rootDir }}/dist",
  },
  commands: {
    preview: "npx serve ./static",
  },
  hooks: {
    "rollup:before": (nitro: Nitro) => {
      deprecateSWR(nitro);
    },
    async compiled(nitro: Nitro) {
      await writeHeaders(nitro);
      await writeRedirects(nitro);
      await writeDeployConfig(nitro);
    },
  },
});

async function writeRedirects(nitro: Nitro) {
  const redirectsPath = join(nitro.options.output.publicDir, "_redirects");
  const staticFallback = existsSync(
    join(nitro.options.output.publicDir, "404.html")
  )
    ? "/* /404.html 404"
    : "";
  let contents = nitro.options.static
    ? staticFallback
    : "/* /.netlify/functions/server 200";

  const rules = Object.entries(nitro.options.routeRules).sort(
    (a, b) => a[0].split(/\/(?!\*)/).length - b[0].split(/\/(?!\*)/).length
  );

  if (!nitro.options.static) {
    // Rewrite static ISR paths to builder functions
    for (const [key, value] of rules.filter(
      ([_, value]) => value.isr !== undefined
    )) {
      contents = value.isr
        ? `${key.replace("/**", "/*")}\t/.netlify/builders/server 200\n` +
          contents
        : `${key.replace("/**", "/*")}\t/.netlify/functions/server 200\n` +
          contents;
    }
  }

  for (const [key, routeRules] of rules.filter(
    ([_, routeRules]) => routeRules.redirect
  )) {
    let code = routeRules.redirect!.statusCode;
    // TODO: Remove map when netlify support 307/308
    if (code === 307) {
      code = 302;
    }
    if (code === 308) {
      code = 301;
    }
    contents =
      `${key.replace("/**", "/*")}\t${routeRules.redirect!.to.replace(
        "/**",
        "/:splat"
      )}\t${code}\n` + contents;
  }

  if (existsSync(redirectsPath)) {
    const currentRedirects = await fsp.readFile(redirectsPath, "utf8");
    if (/^\/\* /m.test(currentRedirects)) {
      nitro.logger.info(
        "Not adding Nitro fallback to `_redirects` (as an existing fallback was found)."
      );
      return;
    }
    nitro.logger.info(
      "Adding Nitro fallback to `_redirects` to handle all unmatched routes."
    );
    contents = currentRedirects + "\n" + contents;
  }

  await fsp.writeFile(redirectsPath, contents);
}

async function writeHeaders(nitro: Nitro) {
  const headersPath = join(nitro.options.output.publicDir, "_headers");
  let contents = "";

  const rules = Object.entries(nitro.options.routeRules).sort(
    (a, b) => b[0].split(/\/(?!\*)/).length - a[0].split(/\/(?!\*)/).length
  );

  for (const [path, routeRules] of rules.filter(
    ([_, routeRules]) => routeRules.headers
  )) {
    const headers = [
      path.replace("/**", "/*"),
      ...Object.entries({ ...routeRules.headers }).map(
        ([header, value]) => `  ${header}: ${value}`
      ),
    ].join("\n");

    contents += headers + "\n";
  }

  if (existsSync(headersPath)) {
    const currentHeaders = await fsp.readFile(headersPath, "utf8");
    if (/^\/\* /m.test(currentHeaders)) {
      nitro.logger.info(
        "Not adding Nitro fallback to `_headers` (as an existing fallback was found)."
      );
      return;
    }
    nitro.logger.info(
      "Adding Nitro fallback to `_headers` to handle all unmatched routes."
    );
    contents = currentHeaders + "\n" + contents;
  }

  await fsp.writeFile(headersPath, contents);
}

function deprecateSWR(nitro: Nitro) {
  if (nitro.options.future.nativeSWR) {
    return;
  }
  let hasLegacyOptions = false;
  for (const [key, value] of Object.entries(nitro.options.routeRules)) {
    if (_hasProp(value, "isr")) {
      continue;
    }
    if (value.cache === false) {
      value.isr = false;
    }
    if (_hasProp(value, "static")) {
      value.isr = !(value as { static: boolean }).static;
      hasLegacyOptions = true;
    }
    if (value && value.cache && _hasProp(value.cache, "swr")) {
      value.isr = value.cache.swr;
      hasLegacyOptions = true;
    }
  }
  if (hasLegacyOptions) {
    console.warn(
      "[nitro] Nitro now uses `isr` option to configure ISR behavior on Netlify. Backwards-compatible support for `static` and `swr` support with Builder Functions will be removed in the future versions. Set `future.nativeSWR: true` nitro config disable this warning."
    );
  }
}

function _hasProp(obj: any, prop: string) {
  return obj && typeof obj === "object" && prop in obj;
}

async function writeDeployConfig(nitro: Nitro) {
  if (nitro.options.netlify) {
    const configPath = join(
      nitro.options.rootDir,
      ".netlify/deploy/v1/config.json"
    );
    await fsp.mkdir(dirname(configPath), { recursive: true });
    await fsp.writeFile(
      configPath,
      JSON.stringify(nitro.options.netlify),
      "utf8"
    );
  }
}
