# BIKO — Watch together

BIKO is a lightweight watch-party web app. Each participant loads the video in their own browser. BIKO sends room state and supported playback commands only; it does not relay video bytes.

## Providers

- **CinemaOS**: movies and TV player links. The library opens in a separate tab; the player itself is embedded.
- **VOE**: paste a VOE embed URL such as `https://voe.sx/e/wwxgipn1bxwc`, a supported `shannoncoldalready.com/e/{code}` URL, or the iframe HTML containing that URL. BIKO validates the URL and embeds the provider's player.
- **Google Drive**: select a video through Google Picker after the site owner configures the BIKO Google OAuth application.

## Synchronization notes

- Host-only synchronization is implemented for providers whose embedded player can be controlled through a documented interface or native HTML5 video.
- Google Drive uses the native HTML5 video element, so BIKO can synchronize play, pause, seek and late joining.
- CinemaOS uses its documented cross-origin player messaging where available.
- The VOE public documentation found for this integration does not document a parent-page API for reading playback time or issuing play/pause/seek commands. VOE rooms therefore embed and play the VOE iframe, but playback is controlled locally inside the VOE player and is not synchronized by BIKO. BIKO deliberately does not guess undocumented postMessage commands, proxy media, extract stream URLs, or interfere with the provider's advertising.
- VOE's terms require that embedded content not have its advertising blocked or visually/technically altered, and that the user possess the necessary content rights. VOE describes its service as intended for adults and notes that advertising may be adult-oriented. Review the provider's terms before use.

## Google Drive setup

Regular BIKO users do not enter Google Cloud credentials. The BIKO site owner configures the application's Google credentials on the Vercel project once. A user then connects their own account, approves the requested access and selects a video.

Environment variables:
- `GOOGLE_DRIVE_CLIENT_ID`
- `GOOGLE_DRIVE_API_KEY`
- `GOOGLE_DRIVE_APP_ID`

Enable Google Picker API and Google Drive API. Use the narrow `drive.file` OAuth scope and authorize the production origin `https://biko-watch-party.vercel.app`.

## Local development

Serve the repository root with any static HTTP server. The app uses the existing sync worker by default: `https://biko.qeshta.workers.dev`.

## Deployment

The repository is configured for a static Vercel deployment. `/room/{roomId}` rewrites to the app entry page.
