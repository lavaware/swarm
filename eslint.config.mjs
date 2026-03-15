import antfu from "@antfu/eslint-config";

export default antfu({
  node: true,
  stylistic: {
    indent: 2,
    quotes: "double",
    semi: true,
  },
  rules: {
    "no-console": "off",
    "antfu/no-top-level-await": "off",
  },
});
