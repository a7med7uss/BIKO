module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).send("Method not allowed");
  }

  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const error = typeof req.query.error === "string" ? req.query.error : "";
  if (error) {
    return res.redirect(302, "https://biko-watch-party.vercel.app/?drive_error=" + encodeURIComponent(error));
  }
  if (!code || !state) {
    return res.redirect(302, "https://biko-watch-party.vercel.app/?drive_error=missing_oauth_response");
  }

  try {
    const response = await fetch("https://biko.qeshta.workers.dev/api/drive/auth/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, state })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.exchangeCode) {
      const message = result.error || "oauth_callback_failed";
      return res.redirect(302, "https://biko-watch-party.vercel.app/?drive_error=" + encodeURIComponent(message));
    }
    return res.redirect(302, "https://biko-watch-party.vercel.app/#biko_auth=" + encodeURIComponent(result.exchangeCode));
  } catch (_) {
    return res.redirect(302, "https://biko-watch-party.vercel.app/?drive_error=oauth_callback_unreachable");
  }
};
