export default {
  base: "./",
  optimizeDeps: {
    exclude: ["web-ifc"],
  },
  server: {
    port: 5173,
    headers: {
      // Allow TC viewer to load our icon data URIs (CORS for any future cross-origin use)
      "Access-Control-Allow-Origin": "*",
    },
  },
};
