// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*"],
  },
  {
    // Server/client boundary (plan §4): src/server/** is imported only from src/app/api/** routes (and from itself).
    // __tests__/boundary.test.ts greps for the same rule so a file excluded from lint cannot slip past it.
    files: ["src/**/*.{js,jsx,ts,tsx}"],
    ignores: ["src/app/api/**", "src/server/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/server", "@/server/**", "**/server/**"],
              message: "src/server is server-only: import it from src/app/api/** routes, never from app, domain, data, services, store or ui code (plan §4).",
            },
          ],
        },
      ],
    },
  },
]);
