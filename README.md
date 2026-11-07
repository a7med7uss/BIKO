# BIKO — Google Drive Watch Party

BIKO is a Google Drive-only watch-party site. The host connects one Google account and chooses a video with Google Picker. The host's refresh token stays on Cloudflare Durable Object storage; guests join with an invitation link and do not authenticate with Google.

## Architecture

- Vercel hosts the static BIKO interface and the OAuth callback function.
- Cloudflare Worker handles OAuth exchange, short-lived host sessions, Google Drive token refresh, room metadata, and byte-range media streaming.
- Cloudflare Durable Objects store room playback state and the host's Google token record.
- Every video request is streamed from Google Drive through the Worker. The Worker forwards the browser's HTTP Range header and streams the upstream body; it does not buffer the whole file.

## Google Cloud app setup (one time, by the BIKO owner)

Create a Google Cloud project and enable:
- Google Drive API
- Google Picker API

Create an OAuth Client ID of type **Web application**:
- Authorized JavaScript origin: `https://biko-watch-party.vercel.app`
- Authorized redirect URI: `https://biko-watch-party.vercel.app/api/drive/oauth-callback`

The OAuth redirect URI must match exactly, including the path and HTTPS scheme. Set the OAuth consent screen to External and publish it to Production when ready for general users. Google external apps left in Testing can receive refresh tokens that expire after seven days.

Configure the OAuth consent screen as External, request only:
- `openid`
- `email`
- `https://www.googleapis.com/auth/drive.file`

Publish the consent screen to Production before real use. Google documents that refresh tokens for external apps left in Testing expire after seven days.

Add these Cloudflare Worker secrets to Worker `biko`:
- `GOOGLE_DRIVE_CLIENT_ID`
- `GOOGLE_DRIVE_CLIENT_SECRET`
- `GOOGLE_DRIVE_API_KEY`
- `GOOGLE_DRIVE_APP_ID` (numeric Cloud project number)

Restrict the API key to the BIKO origin and the Google Picker API / Google Drive API. The user-facing site does not display these values.

## How users use BIKO

1. The host presses **ربط Google Drive** and approves Google access once.
2. The host chooses a video with Google Picker or pastes a Drive link previously opened with BIKO.
3. BIKO creates a room and the host shares the invite link.
4. Guests open the link; they do not need Google sign-in.
5. The host controls play, pause and seek. Guest browsers receive the same stream from BIKO's range proxy.

## Permissions and privacy

- The OAuth scope is `drive.file`, not full Drive read access.
- The app can access files the host explicitly chooses with Google Picker.
- The host's refresh token is stored server-side in a user-specific Durable Object and is never sent to guests.
- The room URL is a bearer invitation: anyone who receives it can view the selected video while the host's Drive permission remains valid.
- BIKO streams media on demand and does not store a permanent copy of the file.

## Important limits

Drive API access, account policies, video codec support, file size, network throughput, and Google quota can affect playback. MP4 using H.264 video and AAC audio provides the broadest browser compatibility. The application forwards HTTP Range requests so seeking can request only the required file segments; final behavior still depends on Google's response for the selected file.
