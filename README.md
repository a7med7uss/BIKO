# BIKO — Google Drive Watch Party

BIKO is a lightweight watch-party website. The host pastes a Google Drive video sharing link, creates a room, and shares the invitation URL. Each viewer's browser loads the same public Drive file directly; BIKO sends playback state over the room WebSocket, not video bytes.

## How to use

1. In Google Drive, open the video's Share dialog.
2. Set General access to Anyone with the link — Viewer.
3. Copy the sharing link and paste it into BIKO.
4. Create the room and share the invitation link with friends.

No Google sign-in, OAuth client, API key, Picker setup, or account linking is required for this public-link flow. Do not paste private Drive links: room members need permission to view the file.

## Playback and compatibility

- Native HTML5 video playback with host-only play, pause and seek controls.
- Playback state is synchronized through the existing Cloudflare Durable Object room service.
- Each participant fetches the video from Google Drive independently; BIKO does not proxy or relay video data.
- The browser/device must support the video's codec and Drive must allow direct download/streaming for the file.
- Google Drive may throttle downloads, require a confirmation page for large files, or restrict files with unusual permissions. These restrictions cannot be eliminated by BIKO. MP4 (H.264/AAC) is the safest compatibility target.

## Architecture

- Frontend: static HTML/CSS/JavaScript hosted on Vercel.
- Realtime sync: Cloudflare Worker + Durable Objects.
- Media: public Google Drive sharing links only.

## Local development

Serve the repository root with any static HTTP server. The app uses https://biko.qeshta.workers.dev.
