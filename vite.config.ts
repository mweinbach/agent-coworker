import { builtinModules } from "node:module";
import { defineConfig } from "vite-plus";

const toolingFiles = [
  "vite.config.ts",
  "apps/desktop/electron.vite.config.ts",
  "apps/desktop/vite.config.web.ts",
  "apps/desktop/quality-gates/electron.vite.config.ts",
];
const rendererFiles = [
  "apps/desktop/src/app/navigation.ts",
  "apps/desktop/src/app/settingsNavigation.ts",
  "apps/desktop/src/app/router.tsx",
  "apps/desktop/src/ui/layout/ScreenLoading.tsx",
];
const ignorePatterns = [
  "**/*",
  "!**/",
  ...[...toolingFiles, ...rendererFiles].map((file) => `!${file}`),
];

export default defineConfig({
  lint: {
    ignorePatterns,
    plugins: ["typescript", "unicorn", "oxc", "import"],
    categories: {
      correctness: "error",
      suspicious: "error",
    },
    options: {
      maxWarnings: 0,
    },
    rules: {
      "typescript/consistent-type-imports": "error",
      "typescript/no-explicit-any": "error",
      "typescript/no-non-null-assertion": "error",
      "typescript/no-empty-object-type": "error",
      "typescript/no-unsafe-function-type": "error",
      "typescript/no-wrapper-object-types": "error",
      "eslint/no-cond-assign": ["error", "always"],
      "eslint/no-return-assign": ["error", "always"],
      "eslint/no-empty": "error",
      "eslint/no-useless-catch": "error",
      "eslint/eqeqeq": "error",
      "eslint/complexity": ["error", 15],
      "import/no-cycle": "error",
    },
    overrides: [
      {
        files: rendererFiles,
        plugins: ["react", "jsx-a11y"],
        rules: {
          "react/react-in-jsx-scope": "off",
          "react/exhaustive-deps": "error",
          "react/no-array-index-key": "error",
          "react/no-render-return-value": "error",
          "react/void-dom-elements-no-children": "error",
          "react/no-danger": "error",
          "eslint/no-restricted-imports": [
            "error",
            {
              paths: [...builtinModules, "electron", "bun"],
              patterns: [
                {
                  regex: "^(node:|bun:|electron/|@electron/)",
                  message: "Renderer modules must use the typed desktop bridge, not native APIs.",
                },
                {
                  group: [
                    "@cowork/**",
                    "!@cowork/shared",
                    "!@cowork/shared/**",
                    "!@cowork/types",
                    "!@cowork/types.ts",
                    "**/src/**",
                    "!**/src/shared",
                    "!**/src/shared/**",
                    "!**/src/types",
                    "!**/src/types.ts",
                  ],
                  message: "Only shared contracts may cross from the harness into the renderer.",
                },
                {
                  regex: "(^|/)(electron|server|providers|runtime|tools|platform|auth|config)(/|$)",
                  message:
                    "Renderer modules must not import harness or privileged implementations.",
                },
              ],
            },
          ],
        },
      },
    ],
  },
  fmt: {
    ignorePatterns,
    printWidth: 100,
    tabWidth: 2,
    useTabs: false,
    endOfLine: "lf",
    singleQuote: false,
    semi: true,
    trailingComma: "all",
    arrowParens: "always",
    sortImports: {
      newlinesBetween: false,
    },
    sortPackageJson: false,
  },
});
