/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // Domain should not depend on infrastructure (dependency inversion)
    {
      name: "domain-to-infra",
      severity: "error",
      comment:
        "Domain layer should not depend on infrastructure. Use dependency injection or interfaces.",
      from: { path: "^src/domain/" },
      to: { path: "^src/infrastructure/" },
    },
    // Cycles should not depend on infrastructure directly
    {
      name: "cycles-to-infra-direct",
      severity: "warn",
      comment: "Cycles should orchestrate via domain, not directly call infrastructure.",
      from: { path: "^src/cycles/" },
      to: { path: "^src/infrastructure/" },
    },
    // Agent should not depend on infrastructure directly
    {
      name: "agent-to-infra-direct",
      severity: "warn",
      comment: "Agent should use tools, not directly call infrastructure.",
      from: { path: "^src/agent/" },
      to: { path: "^src/infrastructure/" },
    },
    // Tools should not depend on cycles (avoid circular dependencies)
    {
      name: "tools-to-cycles",
      severity: "error",
      comment: "Tools should not depend on cycles (prevents circular dependencies).",
      from: { path: "^tools/" },
      to: { path: "^src/cycles/" },
    },
    // Prevent circular dependencies within src
    {
      name: "no-circular-src",
      severity: "error",
      comment: "Circular dependencies within src/ are not allowed.",
      from: { path: "^src/" },
      to: { path: "^src/", circular: true },
    },
    // External dependencies restrictions
    {
      name: "no-node-only",
      severity: "error",
      comment: "Do not import Node.js-only modules in shared code.",
      from: { path: "^src/(utils|types|config|domain)/" },
      to: { dependencyTypes: ["node-only"] },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
      dependencyTypes: ["npm", "npm-dev", "npm-optional", "npm-peer", "npm-bundled", "npm-no-pkg"],
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: "tsconfig.json",
    },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
    reporterOptions: {
      dot: {
        collapsePattern: "node_modules/(^[^/]+)",
      },
    },
  },
};
