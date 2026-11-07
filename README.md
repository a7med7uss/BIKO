# BIKO — Google Drive Watch Party

BIKO is a Google Drive-only watch-party site. The host connects one Google account and chooses a video with Google Picker. Guests join with an invitation link and do not need a Google account.

## No-cost test setup (no paid domain required to start)

Start with Google OAuth in **External / Testing** mode. This is for a small, limited test and is not a permanent public release:
- Add the host's Google account under Test users.
- Google permits up to 100 test users.
- Google refresh-token authorizations for an External app in Testing expire after 7 days, so the host must reconnect weekly.
- Google may show an unverified/testing consent warning.
- A custom domain and production brand verification are not required just to try the testing flow, although Google requires domain ownership verification before full production brand verification. A shared Vercel domain may not qualify for production verification.

Google documents standard Drive API usage as available at no additional cost. Do not enable a billing account for this initial test. Google has announced that quota overages may move to a paid model later in 2026, so keep usage within the published free quotas.

## One-time Google project setup by the BIKO owner

1. Create a project in https://console.cloud.google.com/.
2. Enable **Google Drive API** and **Google Picker API**.
3. Open **Google Auth Platform**:
   - Branding: app name `BIKO`, support email, and contact email.
   - Audience: **External**.
   - Publishing status: **Testing**.
   - Test users: add the host's Google account.
4. Create an OAuth Client ID of type **Web application**. Add this exact Authorized redirect URI:
   `https://biko-watch-party.vercel.app/api/drive/oauth-callback`
5. Create an API key for Google Picker. Restrict it to the BIKO website and the Google Picker API / Drive API. Use the existing production origin:
   `https://biko-watch-party.vercel.app`
6. Note the numeric Google Cloud project number.

The BIKO website does not ask everyday users for any of these values. Store them once as Cloudflare Worker secrets on Worker `biko`:

- `GOOGLE_DRIVE_CLIENT_ID`
- `GOOGLE_DRIVE_CLIENT_SECRET`
- `GOOGLE_DRIVE_API_KEY`
- `GOOGLE_DRIVE_APP_ID` (numeric Cloud project number)

The OAuth redirect URI must match exactly. Do not paste any client secret, API key, refresh token, or access token into GitHub or public chat.

## How people use BIKO

1. The host presses **ربط Google Drive** and approves the Google consent screen.
2. The host presses **اختيار فيديو من Google Drive** and selects a video in the Picker.
3. BIKO creates a room and the host shares its invitation link.
4. Guests open the link without signing in to Google.
5. The host controls play, pause and seek; guests follow the host's playback state.

The URL box accepts a Drive share link only after the file has been opened/shared with the BIKO app by the host. The recommended path is to select the file in Google Picker, because `drive.file` intentionally grants per-file access.

## Architecture

- Vercel serves the BIKO interface and the OAuth callback.
- Cloudflare Worker handles OAuth token exchange, host sessions, token refresh, room metadata, and media streaming.
- Cloudflare Durable Objects store playback state and encrypted-at-rest provider records.
- The Worker streams Google Drive media using `files.get?alt=media` and forwards byte-range requests. It streams the upstream response rather than buffering the entire video.
- Guests do not receive Google's OAuth tokens. The room URL is a bearer invitation, so anyone with that URL can watch the selected video while the host's Google authorization remains valid.

## Permissions and privacy

- BIKO requests only the `drive.file` scope, which is intended for files selected/opened with the app, rather than full access to all Drive files.
- The host's refresh token remains server-side in Cloudflare Durable Object storage.
- Video bytes pass through Cloudflare while being watched; BIKO does not keep a permanent copy.
- See `/privacy.html`.

## Playback compatibility

Playback still depends on Drive API access, file permissions, Google quota, browser codecs, and network throughput. MP4 with H.264 video and AAC audio is the safest browser target. Range forwarding supports seeking, but no service can promise zero stalls on every device/network.
