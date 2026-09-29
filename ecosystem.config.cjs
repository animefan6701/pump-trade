const { resolve } = require("path");

module.exports = {
  apps: [
    {
      name: "pump-desk",
      cwd: resolve(__dirname, "web"),
      script: "./node_modules/next/dist/bin/next",
      args: "start --port 3000",
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "1500M",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
