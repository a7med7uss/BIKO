# BIKO — Watch together

BIKO is a lightweight watch-party web app. Every participant loads the CinemaOS player directly in their own browser; BIKO only sends room state and playback commands, not video data.

## Features

- CinemaOS movie and TV player links.
- Embedded CinemaOS browsing panel with a manual link-paste fallback.
- Watch rooms backed by the existing Cloudflare Durable Object service.
- Host-only synchronized play, pause, and seek controls.
- Late-join room snapshots and reconnect handling.
- Each viewer keeps their own subtitle, audio, and quality preferences inside the CinemaOS player.

## Run locally

Serve this directory with any static HTTP server. The app uses the public BIKO sync Worker by default:

`https://biko.qeshta.workers.dev`

To use a different sync endpoint, set `window.BIKO_SYNC_API` before loading `app.js` in `index.html`.

## CinemaOS links

Movies use:

`https://cinemaos.tech/player/{tmdb_id}`

TV episodes use:

`https://cinemaos.tech/player/{tmdb_id}/{season}/{episode}`

Paste the player URL into the homepage to create a room. The embedded browser attempts to pick up a CinemaOS selection message when the provider emits one; otherwise, open CinemaOS in a separate tab and paste the player URL manually.

## Playback and subtitles

The host is the first participant to connect to a new room. Only the host's playback events are broadcast. Other viewers follow the room state while choosing subtitles and audio locally in their own CinemaOS player. Player-side behavior depends on CinemaOS's cross-origin messaging API and its current embed implementation.

## Deployment

The repository is configured for a static Vercel deployment. Room URLs under `/room/{roomId}` are rewritten to the app entry page.

The project contains no video proxy and does not fetch or redistribute media files. CinemaOS and its third-party providers remain responsible for media playback and availability.
