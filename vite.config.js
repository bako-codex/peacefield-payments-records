const { defineConfig, loadEnv } = require("vite");
const { createRequire } = require("node:module");

const localRequire = createRequire(__filename);
const apiHandlers = {
  "/api/payments": localRequire("./api/payments.js"),
  "/api/auth/register": localRequire("./api/auth/register.js"),
  "/api/auth/activate": localRequire("./api/auth/activate.js"),
  "/api/auth/invitations": localRequire("./api/auth/invitations.js"),
  "/api/auth/otp": localRequire("./api/auth/otp.js"),
  "/api/auth/verify-otp": localRequire("./api/auth/verify-otp.js"),
  "/api/auth/invitation-details": localRequire("./api/auth/invitation-details.js"),
  "/api/auth/my-invitation": localRequire("./api/auth/my-invitation.js"),
  "/api/records/fields": localRequire("./api/records/fields.js"),
};

module.exports = defineConfig(({ mode }) => {
  Object.assign(process.env, loadEnv(mode, process.cwd(), ""));
  return {
    publicDir: "public",
    plugins: [{
      name: "local-api",
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          const pathname = new URL(request.url, "http://localhost").pathname;
          const handler = apiHandlers[pathname];
          if (!handler) {
            next();
            return;
          }

          try {
            if (request.method === "POST") {
              const chunks = [];
              let size = 0;
              for await (const chunk of request) {
                size += chunk.length;
                if (size > 10_000) {
                  response.statusCode = 413;
                  response.end(JSON.stringify({ error: "Request body is too large." }));
                  return;
                }
                chunks.push(chunk);
              }
              request.body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
            }
            await handler(request, response);
          } catch (error) {
            console.error(`Local API request failed (${pathname}):`, error);
            if (!response.headersSent) {
              response.writeHead(500, { "Content-Type": "application/json" });
              response.end(JSON.stringify({ error: "The server could not complete this request." }));
            }
          }
        });
      },
    }],
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
    },
  };
});
