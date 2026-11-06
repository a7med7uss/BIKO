# BIKO — Watch together

BIKO is a lightweight watch-party web app. Each participant loads the video in their own browser. BIKO sends room state and playback commands only; it does not relay video bytes.

## Features

- CinemaOS movie and TV player links.
- CinemaOS library opens in a separate tab because the catalogue page does not reliably allow framing. The official CinemaOS player endpoint is embedded in BIKO.
- Google Drive video selection through the official Google Picker.
- Host-only synchronized play, pause, seek, and late-join position.
- Drive playback uses the browser's native HTML5 video element.
- Each viewer controls their own Drive playback volume.
- Room state and membership are backed by the existing Cloudflare Durable Object worker.

## Google Drive: one-time site-owner setup

Regular BIKO users do **not** enter Google Cloud credentials. Once the BIKO owner has configured the Google application, a user presses **ربط Google Drive واختيار فيديو**, chooses a Google account, approves the requested file access, and selects a video.

The Vercel project uses these server-side environment variables:

- `GOOGLE_DRIVE_CLIENT_ID`: OAuth 2.0 Web client ID.
- `GOOGLE_DRIVE_API_KEY`: API key restricted to the BIKO origin and Google Picker/Drive APIs.
- `GOOGLE_DRIVE_APP_ID`: the numeric Google Cloud project number.

Enable Google Picker API and Google Drive API in the same Cloud project. The OAuth consent configuration must use the narrow `drive.file` scope. Add `https://biko-watch-party.vercel.app` as an authorized JavaScript origin. These settings are managed by the site owner in Vercel, not by each user.

Official setup guide: https://developers.google.com/workspace/drive/picker/guides/web-picker.

## Drive sharing and privacy

- BIKO requests the `drive.file` scope: access to files the user chooses through Google Picker, rather than broad access to all Drive files.
- The Google access token stays in browser memory and is not written to BIKO storage.
- If the owner already shared the file with every viewer, leave the public-link checkbox off.
- If viewers need access, the host can explicitly tick the consent box before choosing a file. BIKO adds an `anyone: reader` permission to that file through the Drive API.
- Anyone who obtains that file link can then view it. This permission remains after the BIKO room ends until the owner revokes it in Google Drive.
- BIKO does not silently change sharing permissions.
- See `/privacy.html` for the user-facing privacy notice.

## CinemaOS

Movie player URLs:

`https://cinemaos.tech/player/{tmdb_id}`

TV episode URLs:

`https://cinemaos.tech/player/{tmdb_id}/{season}/{episode}`

Open CinemaOS in a separate tab, open the title's player page, then paste the player URL into BIKO.

## Local development

Serve the repository root with any static HTTP server. The app uses the existing sync worker by default:

`https://biko.qeshta.workers.dev`

To use a different sync API, set `window.BIKO_SYNC_API` before loading `app.js`.

## Deployment

The repository is configured for a static Vercel deployment. The `/room/{roomId}` rewrite serves the app shell for direct room links.
