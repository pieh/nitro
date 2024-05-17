import { promises as fsp } from "node:fs";
import { resolve } from "pathe";
import destr from "destr";
import { describe, it, expect } from "vitest";
import { Handler, APIGatewayEvent } from "aws-lambda";
import { getPresetTmpDir, setupTest, testNitro } from "../tests";

describe("nitro:preset:netlify:v1", async () => {
  const ctx = await setupTest("netlify-v1", {
    config: {
      output: {
        publicDir: resolve(getPresetTmpDir("netlify-v1"), "dist"),
      },
      netlify: {
        images: {
          remote_images: ["https://example.com/.*"],
        },
      },
    },
  });
  testNitro(
    ctx,
    async () => {
      const { handler } = (await import(
        resolve(ctx.outDir, "server/server.mjs")
      )) as { handler: Handler };
      return async ({ url: rawRelativeUrl, headers, method, body }) => {
        // creating new URL object to parse query easier
        const url = new URL(`https://example.com${rawRelativeUrl}`);
        const queryStringParameters = Object.fromEntries(
          url.searchParams.entries()
        );
        const event: Partial<APIGatewayEvent> = {
          resource: "/my/path",
          path: url.pathname,
          headers: headers || {},
          httpMethod: method || "GET",
          queryStringParameters,
          body: body || "",
        };
        const res = await handler(event, {} as any, () => {});
        const resHeaders = { ...res.headers, ...res.multiValueHeaders };
        return {
          data: destr(res.body),
          status: res.statusCode,
          headers: resHeaders,
        };
      };
    },
    () => {
      it("should add route rules - redirects", async () => {
        const redirects = await fsp.readFile(
          resolve(ctx.outDir, "../dist/_redirects"),
          "utf8"
        );

        expect(redirects).toMatchInlineSnapshot(`
        "/rules/nested/override	/other	302
        /rules/redirect/wildcard/*	https://nitro.unjs.io/:splat	302
        /rules/redirect/obj	https://nitro.unjs.io/	301
        /rules/nested/*	/base	302
        /rules/redirect	/base	302
        /rules/_/cached/noncached	/.netlify/functions/server 200
        /rules/_/noncached/cached	/.netlify/builders/server 200
        /rules/_/cached/*	/.netlify/builders/server 200
        /rules/_/noncached/*	/.netlify/functions/server 200
        /rules/swr-ttl/*	/.netlify/builders/server 200
        /rules/swr/*	/.netlify/builders/server 200
        /rules/isr-ttl/*	/.netlify/builders/server 200
        /rules/isr/*	/.netlify/builders/server 200
        /rules/dynamic	/.netlify/functions/server 200
        /* /.netlify/functions/server 200"
      `);
      });
      it("should add route rules - headers", async () => {
        const headers = await fsp.readFile(
          resolve(ctx.outDir, "../dist/_headers"),
          "utf8"
        );

        expect(headers).toMatchInlineSnapshot(`
        "/rules/headers
          cache-control: s-maxage=60
        /rules/cors
          access-control-allow-origin: *
          access-control-allow-methods: GET
          access-control-allow-headers: *
          access-control-max-age: 0
        /rules/nested/*
          x-test: test
        /build/*
          cache-control: public, max-age=3600, immutable
        "
      `);
      });
      it("should write config.json", async () => {
        const config = await fsp
          .readFile(
            resolve(ctx.rootDir, ".netlify/deploy/v1/config.json"),
            "utf8"
          )
          .then((r) => JSON.parse(r));
        expect(config).toMatchInlineSnapshot(`
          {
            "images": {
              "remote_images": [
                "https://example.com/.*",
              ],
            },
          }
        `);
      });
    }
  );
});
