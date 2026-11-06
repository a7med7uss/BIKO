module.exports = function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Vary", "Origin");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ enabled: false, error: "Method not allowed" });
  }

  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID || "";
  const apiKey = process.env.GOOGLE_DRIVE_API_KEY || "";
  const appId = process.env.GOOGLE_DRIVE_APP_ID || "";
  const enabled = Boolean(
    clientId.endsWith(".apps.googleusercontent.com") &&
    apiKey.length >= 20 &&
    /^\d{6,}$/.test(appId)
  );

  return res.status(enabled ? 200 : 503).json({
    enabled,
    ...(enabled ? { clientId, apiKey, appId } : {})
  });
};
