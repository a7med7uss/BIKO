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

## CinemaOS

Movie player URLs:

\`https://cinemaos.tech/player/{tmdb_id}\`

TV episode URLs:

\`https://cinemaos.tech/player/{tmdb_id}/{season}/{episode}\`

Open CinemaOS in a separate tab, navigate to a film and open its player page, then paste the player URL into BIKO. CinemaOS documents the /player routes and cross-origin player messaging on its embed guide: https://cinemaos.tech/embed.

## Google Drive setup

Google Drive uses the official Google Picker API and Drive API. The host configures the Google credentials once in the BIKO browser on their device.

1. Create or choose a Google Cloud project.
2. Enable **Google Picker API** and **Google Drive API**.
3. Create an API key. Restrict it to the BIKO website origin and the Picker/Drive APIs.
4. Create an OAuth client ID of type **Web application**.
5. Add this Authorized JavaScript origin:
   \`https://biko-watch-party.vercel.app\`
6. Copy the OAuth client ID, API key, and numeric Cloud project number into BIKO → **إعداد Google Drive**.
7. Save and press **اختيار فيديو من Google Drive**.

BIKO asks for the \`drive.file\` OAuth scope. The access token is kept in browser memory only and is not stored in BIKO or sent to the room service.

### Drive sharing and privacy

- If the file is already shared with all viewers, leave the public-link checkbox off.
- If viewers need access, the host can explicitly tick the consent box before choosing a file. BIKO then adds an \`anyone: reader\` permission to that file through the Drive API.
- Anyone who obtains that file link can then view it. This permission remains after the BIKO room ends until the owner revokes it in Google Drive.
- BIKO does not silently change sharing permissions.

Google Picker requires a Cloud project, API key, OAuth web client, and user consent: https://developers.google.com/workspace/drive/picker/guides/web-picker.
Google Drive documents \`webContentLink\` as the browser download link for binary files: https://developers.google.com/workspace/drive/api/guides/manage-downloads.
The video element uses that link directly, so video data is requested by each viewer's browser from Google Drive rather than passing through BIKO. Playback depends on the selected file being downloadable and accessible to each participant.

## Local development

Serve the repository root with any static HTTP server. The app uses the existing sync worker by default:

\`https://biko.qeshta.workers.dev\`

To use a different sync API, set \`window.BIKO_SYNC_API\` before loading \`app.js\`.

## Deployment

The repository is configured for a static Vercel deployment. The \`/room/{roomId}\` rewrite serves the app shell for direct room links.
