import { defineConfig } from "vite";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    environment: "node",
    watch: false,
  },
});
