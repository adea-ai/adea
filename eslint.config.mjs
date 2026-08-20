import nextConfig from "eslint-config-next/core-web-vitals";

export default [
  ...nextConfig,
  {
    ignores: ["**/.next/**", "**/dist/**", "**/node_modules/**"],
  },
  {
    rules: {
      "@next/next/no-html-link-for-pages": "off",
    },
    settings: {
      react: {
        version: "19.2",
      },
    },
  },
];
