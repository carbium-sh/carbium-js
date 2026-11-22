# @carbium/mcp, the Carbium MCP server over stdio, for MCP clients that run containers:
#   docker run -i --rm -e CARBIUM_KEY ghcr.io/carbium-sh/carbium-mcp:<version>
# The build context is a folder of npm tarballs: CI packs @carbium/sdk and @carbium/mcp from the checkout, and a release
# passes the one @carbium/mcp tarball it just published, so npm takes @carbium/sdk from the registry as npx users get it.
# Nothing here sets a key or a CARBIUM_ variable; the client passes them at run time.
ARG INSTALL=node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
ARG RUNTIME=gcr.io/distroless/nodejs24-debian13:nonroot@sha256:6abfcb367ebc291572c774c1592a986be2ab26a2486f73093401327495a5962a

# Pure JavaScript: installed once on the build machine, the same files serve every platform with no emulation.
FROM --platform=$BUILDPLATFORM ${INSTALL} AS install
COPY *.tgz /pkg/
WORKDIR /app
RUN npm init -y >/dev/null \
 && npm install --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error /pkg/*.tgz \
 && test -f node_modules/@carbium/mcp/dist/bin.mjs

FROM ${RUNTIME}
LABEL org.opencontainers.image.source="https://github.com/carbium-sh/carbium-js" \
      org.opencontainers.image.description="Carbium MCP server over stdio: Solana RPC and DAS reads, swap quotes, unsigned swap and DCA transactions, tokens, account usage" \
      org.opencontainers.image.licenses="MIT" \
      io.modelcontextprotocol.server.name="sh.carbium/mcp"
ENV NODE_ENV=production
COPY --from=install /app /app
USER 65532:65532
ENTRYPOINT ["/nodejs/bin/node", "/app/node_modules/@carbium/mcp/dist/bin.mjs"]
